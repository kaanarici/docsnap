import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

type TypeAssertion = ESTree.TSAsExpression | ESTree.TSTypeAssertion;

function isConstAssertion(node: TypeAssertion): boolean {
	return (
		node.typeAnnotation.type === "TSTypeReference" &&
		node.typeAnnotation.typeName.type === "Identifier" &&
		node.typeAnnotation.typeName.name === "const"
	);
}

export const noTypeAssertionsRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow TypeScript type assertions except const assertions.",
		},
		messages: {
			forbidden:
				"Replace this type assertion with runtime narrowing or a compiler-checked data shape.",
		},
	},
	createOnce(context) {
		const checkAssertion = (node: TypeAssertion) => {
			if (!isConstAssertion(node)) {
				context.report({ node, messageId: "forbidden" });
			}
		};

		return {
			TSAsExpression: checkAssertion,
			TSTypeAssertion: checkAssertion,
		};
	},
});
