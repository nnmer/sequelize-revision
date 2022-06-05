import { forEach, map, filter, keys, omit, omitBy, pickBy } from "lodash";
import { Sequelize, DataTypes, Model, ModelAttributes } from "sequelize";
import { ModelDefined } from "sequelize/types/model";
import { createNamespace, getNamespace, Namespace } from "cls-hooked";
import * as jsdiff from "diff";
import helpers from "./helpers";
import { Options, defaultOptions } from "./options";

export class SequelizeRevision {
  Revision: ModelDefined<any, any>;
  RevisionChange?: ModelDefined<any, any>;

  private options: Options;
  private useJsonDataType: boolean;
  private ns?: Namespace;
  private failHard = false;

  constructor(private sequelize: Sequelize, options?: Partial<Options>) {
    this.options = { ...defaultOptions, ...options };
    if (this.options.underscoredAttributes) {
      helpers.snakeCaseValues(this.options.defaultAttributes);
    }

    this.useJsonDataType = this.sequelize.getDialect() !== "mssql";

    if (this.options.continuationNamespace) {
      this.ns = getNamespace(this.options.continuationNamespace);
      if (!this.ns) {
        this.ns = createNamespace(this.options.continuationNamespace);
      }
    }

    // Attributes for RevisionModel
    const revisionAttributes: ModelAttributes = {
      model: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      document: {
        type: this.useJsonDataType ? DataTypes.JSON : DataTypes.TEXT("medium"),
        allowNull: false,
      },
      [this.options.defaultAttributes.documentId]: {
        type: this.options.UUID ? DataTypes.UUID : DataTypes.INTEGER,
        allowNull: false,
      },
      operation: DataTypes.STRING(7),
      [this.options.revisionAttribute]: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
    };

    if (this.options.UUID) {
      revisionAttributes.id = {
        primaryKey: true,
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
      };
    }

    helpers.debugConsole("attributes", revisionAttributes);

    // Revision model
    this.Revision = this.sequelize.define(
      this.options.revisionModel,
      revisionAttributes,
      {
        underscored: this.options.underscored,
        createdAt: this.options.underscoredAttributes
          ? "created_at"
          : undefined,
        updatedAt: this.options.underscoredAttributes
          ? "updated_at"
          : undefined,
        tableName: this.options.tableName,
      }
    );

    if (this.options.enableRevisionChangeModel) {
      // Attributes for RevisionChangeModel
      const revisionChangeAttributes: ModelAttributes = {
        path: {
          type: DataTypes.TEXT,
          allowNull: false,
        },
        document: {
          type: this.useJsonDataType
            ? DataTypes.JSON
            : DataTypes.TEXT("medium"),
          allowNull: false,
        },
        diff: {
          type: this.useJsonDataType
            ? DataTypes.JSON
            : DataTypes.TEXT("medium"),
          allowNull: false,
        },
      };

      if (this.options.UUID) {
        revisionChangeAttributes.id = {
          primaryKey: true,
          type: DataTypes.UUID,
          defaultValue: DataTypes.UUIDV4,
        };
      }
      // RevisionChange model
      this.RevisionChange = this.sequelize.define(
        this.options.revisionChangeModel,
        revisionChangeAttributes,
        {
          underscored: this.options.underscored,
          createdAt: this.options.underscoredAttributes
            ? "created_at"
            : undefined,
          updatedAt: this.options.underscoredAttributes
            ? "updated_at"
            : undefined,
          tableName: this.options.changeTableName,
        }
      );
    }
  }

  // Return defineModels()
  public async defineModels(): Promise<{
    Revision: ModelDefined<any, any>;
    RevisionChange?: ModelDefined<any, any>;
  }> {
    if (this.options.userModel) {
      this.Revision.belongsTo(this.sequelize.model(this.options.userModel), {
        foreignKey: this.options.userModelAttribute,
        ...this.options.belongsToUserOptions,
      });
    }

    if (this.options.enableMigration) {
      await this.Revision.sync();
    }

    if (this.RevisionChange) {
      // Set associations
      this.Revision.hasMany(this.RevisionChange, {
        foreignKey: this.options.defaultAttributes.revisionId,
        constraints: false,
      });

      this.RevisionChange.belongsTo(this.Revision, {
        foreignKey: this.options.defaultAttributes.revisionId,
      });

      if (this.options.enableMigration) {
        await this.RevisionChange.sync();
      }

      return { Revision: this.Revision, RevisionChange: this.RevisionChange };
    }

    return { Revision: this.Revision };
  }

  // order in which sequelize processes the hooks
  // (1)
  // beforeBulkCreate(instances, options, fn)
  // beforeBulkDestroy(instances, options, fn)
  // beforeBulkUpdate(instances, options, fn)
  // (2)
  // beforeValidate(instance, options, fn)
  // (-)
  // validate
  // (3)
  // afterValidate(instance, options, fn)
  // - or -
  // validationFailed(instance, options, error, fn)
  // (4)
  // beforeCreate(instance, options, fn)
  // beforeDestroy(instance, options, fn)
  // beforeUpdate(instance, options, fn)
  // (-)
  // create
  // destroy
  // update
  // (5)
  // afterCreate(instance, options, fn)
  // afterDestroy(instance, options, fn)
  // afterUpdate(instance, options, fn)
  // (6)
  // afterBulkCreate(instances, options, fn)
  // afterBulkDestroy(instances, options, fn)
  // afterBulkUpdate(instances, options, fn)

  // Extend model prototype with "trackRevision" function
  // Call model.trackRevision() to enable revisions for model
  public async trackRevision(
    model: ModelDefined<any, any>,
    options: { exclude?: string[] } = {}
  ): Promise<void> {
    helpers.debugConsole("Enabling paper trail on", model.name);

    model.rawAttributes[this.options.revisionAttribute] = {
      type: DataTypes.INTEGER,
    };

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    model.refreshAttributes();

    if (this.options.enableMigration) {
      const tableName = model.getTableName();

      const queryInterface = this.sequelize.getQueryInterface();

      const attributes = await queryInterface.describeTable(tableName);
      if (!attributes[this.options.revisionAttribute]) {
        helpers.debugConsole("adding revision attribute to the database");

        try {
          await queryInterface.addColumn(
            tableName,
            this.options.revisionAttribute,
            {
              type: DataTypes.INTEGER,
            }
          );
        } catch (err) {
          helpers.debugConsole("something went really wrong..", err);
        }
      }
    }

    const modelExclude = options.exclude || [];
    model.addHook(
      "beforeCreate",
      this.createBeforeHook("create", modelExclude)
    );
    model.addHook(
      "beforeDestroy",
      this.createBeforeHook("destroy", modelExclude)
    );
    model.addHook(
      "beforeUpdate",
      this.createBeforeHook("update", modelExclude)
    );
    model.addHook(
      "beforeUpsert",
      this.createBeforeHook("upsert", modelExclude)
    );
    model.addHook("afterCreate", this.createAfterHook("create", modelExclude));
    model.addHook(
      "afterDestroy",
      this.createAfterHook("destroy", modelExclude)
    );
    model.addHook("afterUpdate", this.createAfterHook("update", modelExclude));
    model.addHook("afterUpsert", this.createAfterHook("upsert", modelExclude));

    // create association
    model.hasMany(this.sequelize.models[this.options.revisionModel], {
      foreignKey: this.options.defaultAttributes.documentId,
      constraints: false,
      scope: {
        model: model.name,
      },
    });
  }

  /**
   * Throw exceptions when the user identifier from CLS is not set or if the
   * revisionAttribute was not loaded on the model.
   */
  enableFailHard() {
    this.failHard = true;
  }

  private createBeforeHook(operation: string, modelExclude: string[]) {
    const exclude = [...this.options.exclude, ...modelExclude];
    return (instance: any, opt: any) => {
      if (!(instance instanceof Model) && opt.instance instanceof Model) {
        instance = opt.instance;
      }

      helpers.debugConsole("beforeHook called");
      helpers.debugConsole("instance:", instance);
      helpers.debugConsole("opt:", opt);

      if (opt.noRevision) {
        helpers.debugConsole("noRevision opt: is true, not logging");
        return;
      }

      const destroyOperation = operation === "destroy";

      let previousVersion: any = {};
      let currentVersion: any = {};
      if (!destroyOperation && this.options.enableCompression) {
        forEach(opt.defaultFields, (a) => {
          previousVersion[a] = instance._previousDataValues[a];
          currentVersion[a] = instance.dataValues[a];
        });
      } else {
        previousVersion = instance._previousDataValues;
        currentVersion = instance.dataValues;
      }
      // Supported nested models.
      previousVersion = omitBy(
        previousVersion,
        (i) => i != null && typeof i === "object" && !(i instanceof Date)
      );
      previousVersion = omit(previousVersion, exclude);

      currentVersion = omitBy(
        currentVersion,
        (i) => i != null && typeof i === "object" && !(i instanceof Date)
      );
      currentVersion = omit(currentVersion, exclude);

      // Disallow change of revision
      instance.set(
        this.options.revisionAttribute,
        instance._previousDataValues[this.options.revisionAttribute]
      );

      // Get diffs
      const delta = helpers.calcDelta(
        previousVersion,
        currentVersion,
        exclude,
        this.options.enableStrictDiff
      );

      const currentRevisionId = instance.get(this.options.revisionAttribute);

      if (this.failHard && !currentRevisionId && opt.type === "UPDATE") {
        throw new Error("Revision Id was undefined");
      }

      helpers.debugConsole("delta:", delta);
      helpers.debugConsole("revisionId", currentRevisionId);

      // Check if all required fields have been provided to the opts / CLS
      if (this.options.metaDataFields) {
        // get all required field keys as an array
        const requiredFields = keys(
          pickBy(this.options.metaDataFields, (required) => required)
        );
        if (requiredFields && requiredFields.length) {
          const metaData = {
            ...opt.revisionMetaData,
            ...(this.ns && this.ns.get(this.options.metaDataContinuationKey)),
          };
          const requiredFieldsProvided = filter(
            requiredFields,
            (field) => metaData[field] !== undefined
          );
          if (requiredFieldsProvided.length !== requiredFields.length) {
            helpers.debugConsole(
              "Required fields: ",
              this.options.metaDataFields,
              requiredFields
            );
            helpers.debugConsole(
              "Required fields provided: ",
              metaData,
              requiredFieldsProvided
            );
            throw new Error(
              "Not all required fields are provided to paper trail!"
            );
          }
        }
      }

      if (destroyOperation || (delta && delta.length > 0)) {
        const revisionId = (currentRevisionId || 0) + 1;
        instance.set(this.options.revisionAttribute, revisionId);

        if (!instance.context) {
          instance.context = {};
        }
        instance.context.delta = delta;
      } else {
        if (instance.context) {
          instance.context.delta = null;
        }
      }

      helpers.debugConsole("end of beforeHook");
    };
  }

  private createAfterHook(operation: string, modelExclude: string[]) {
    const exclude = [...this.options.exclude, ...modelExclude];
    return async (instance: any, opt: any) => {
      if (instance instanceof Array) {
        instance = instance[0];
      }

      helpers.debugConsole("afterHook called");
      helpers.debugConsole("instance:", instance);
      helpers.debugConsole("opt:", opt);
      if (this.ns) {
        helpers.debugConsole(
          `CLS ${this.options.continuationKey}:`,
          this.ns.get(this.options.continuationKey)
        );
      }

      const destroyOperation = operation === "destroy";

      if (
        instance.context &&
        ((instance.context.delta && instance.context.delta.length > 0) ||
          destroyOperation)
      ) {
        const Revision = this.sequelize.model(this.options.revisionModel);
        let RevisionChange: ModelDefined<any, any>;

        if (this.options.enableRevisionChangeModel) {
          RevisionChange = this.sequelize.model(
            this.options.revisionChangeModel
          );
        }

        const { delta } = instance.context;

        let previousVersion: any = {};
        let currentVersion: any = {};
        if (!destroyOperation && this.options.enableCompression) {
          forEach(opt.defaultFields, (a) => {
            previousVersion[a] = instance._previousDataValues[a];
            currentVersion[a] = instance.dataValues[a];
          });
        } else {
          previousVersion = instance._previousDataValues;
          currentVersion = instance.dataValues;
        }

        // Supported nested models.
        previousVersion = omitBy(
          previousVersion,
          (i) => i != null && typeof i === "object" && !(i instanceof Date)
        );
        previousVersion = omit(previousVersion, exclude);

        currentVersion = omitBy(
          currentVersion,
          (i) => i != null && typeof i === "object" && !(i instanceof Date)
        );
        currentVersion = omit(currentVersion, exclude);

        if (
          this.failHard &&
          this.ns &&
          !this.ns.get(this.options.continuationKey)
        ) {
          throw new Error(
            `The CLS continuationKey ${this.options.continuationKey} was not defined.`
          );
        }

        let document = currentVersion;

        if (!this.useJsonDataType) {
          document = JSON.stringify(document);
        }

        // Build revision
        const query: { [key: string]: any } = {
          model: instance.constructor.name,
          document,
          operation,
        };

        // Add all extra data fields to the query object
        if (this.options.metaDataFields) {
          const metaData = {
            ...opt.revisionMetaData,
            ...(this.ns && this.ns.get(this.options.metaDataContinuationKey)),
          };
          if (metaData) {
            forEach(this.options.metaDataFields, (required, field) => {
              const value = metaData[field];
              helpers.debugConsole(
                `Adding metaData field to Revision - ${field} => ${value}`
              );
              if (!(field in query)) {
                query[field] = value;
              } else {
                helpers.debugConsole(
                  `Revision object already has a value at ${field} => ${query[field]}`
                );
                helpers.debugConsole("Not overwriting the original value");
              }
            });
          }
        }

        // in case of custom user models that are not 'userId'
        query[this.options.userModelAttribute] =
          (this.ns && this.ns.get(this.options.continuationKey)) || opt.userId;

        query[this.options.defaultAttributes.documentId] = instance.id;

        const revision: any = Revision.build(query);

        revision[this.options.revisionAttribute] = instance.get(
          this.options.revisionAttribute
        );

        // Save revision
        try {
          const objectRevision = await revision.save({
            transaction: opt.transaction,
          });
          // Loop diffs and create a revision-diff for each
          if (this.options.enableRevisionChangeModel) {
            await Promise.all(
              map(delta, async (difference) => {
                const o = helpers.diffToString(
                  difference.item ? difference.item.lhs : difference.lhs
                );
                const n = helpers.diffToString(
                  difference.item ? difference.item.rhs : difference.rhs
                );

                // let document = difference;
                document = difference;
                let diff: any = o || n ? jsdiff.diffChars(o, n) : [];

                if (!this.useJsonDataType) {
                  document = JSON.stringify(document);
                  diff = JSON.stringify(diff);
                }

                const d = RevisionChange.build({
                  path: difference.path[0],
                  document,
                  diff,
                  revisionId: objectRevision.id,
                });

                try {
                  const savedD = await d.save({ transaction: opt.transaction });
                  // Add diff to revision
                  objectRevision[
                    `add${helpers.capitalizeFirstLetter(
                      this.options.revisionChangeModel
                    )}`
                  ](savedD);
                } catch (err) {
                  helpers.debugConsole("RevisionChange save error", err);
                  throw err;
                }
              })
            );
          }
        } catch (err) {
          helpers.debugConsole("Revision save error", err);
          throw err;
        }
      }

      helpers.debugConsole("end of afterHook");
    };
  }
}
