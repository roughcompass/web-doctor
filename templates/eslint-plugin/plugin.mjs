export default {
  rules: {
    "no-template-bad": {
      create(context) {
        return {
          Identifier(node) {
            if (node.name === "templateBad") context.report({ node, message: "Avoid templateBad." });
          },
        };
      },
    },
  },
};