import type { ESTree, SourceCode } from "@oxlint/plugins";

export type FunctionParameter = ESTree.ParamPattern;

/** Return whether a type is or contains TypeScript's absorbing unknown top type. */
export function containsUnknownType(type: ESTree.TSType): boolean {
	if (type.type === "TSUnknownKeyword") return true;
	if (type.type === "TSParenthesizedType") return containsUnknownType(type.typeAnnotation);
	return type.type === "TSUnionType" && type.types.some(containsUnknownType);
}

/** Return the TypeScript annotation attached to a function parameter or its wrapped binding. */
export function functionParameterTypeAnnotation(
	parameter: FunctionParameter,
): ESTree.TSTypeAnnotation | null | undefined {
	if (parameter.type === "TSParameterProperty") {
		return functionParameterTypeAnnotation(parameter.parameter);
	}
	if (parameter.type === "RestElement") {
		return parameter.typeAnnotation ?? functionParameterTypeAnnotation(parameter.argument);
	}
	if (parameter.type === "AssignmentPattern") {
		return parameter.typeAnnotation ?? functionParameterTypeAnnotation(parameter.left);
	}
	return parameter.typeAnnotation;
}

/** Return only a function parameter's local binding, excluding its annotation and default value. */
export function functionParameterBindingName(
	parameter: FunctionParameter,
	sourceCode: SourceCode,
): string {
	if (parameter.type === "TSParameterProperty") {
		return functionParameterBindingName(parameter.parameter, sourceCode);
	}
	if (parameter.type === "AssignmentPattern") {
		return functionParameterBindingName(parameter.left, sourceCode);
	}
	if (parameter.type === "RestElement") {
		return functionParameterBindingName(parameter.argument, sourceCode);
	}
	if (parameter.type === "Identifier") return parameter.name;

	const sourceText = sourceCode.getText(parameter);
	// AKERU: @oxlint/plugins 1.72 types an identifier's typeAnnotation as null; upstream targets 1.78.
	const annotated: { readonly typeAnnotation?: ESTree.TSTypeAnnotation | null } = parameter;
	const annotationStart = annotated.typeAnnotation?.start;
	return annotationStart === undefined
		? sourceText
		: sourceText.slice(0, annotationStart - parameter.start).trimEnd();
}
