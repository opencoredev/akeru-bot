export interface GeneratedPaths {
  readonly generatedDir: string;
  readonly schemaOutputPath: string;
  readonly metaOutputPath: string;
  readonly namespacesOutputPath: string;
}

export interface MethodEntry {
  readonly method: string;
  readonly paramsType?: string;
}

export interface JsonSchemaFile {
  readonly namespace?: string;
  readonly exportName: string;
  readonly fileName: string;
  readonly downloadUrl: string;
  readonly qualifiedName: string;
}
