import colors from "color-name";
import postcss, { type AnyNode } from "postcss";
import valueParser from "postcss-value-parser";

const colorFunctions = new Set([
  "rgb",
  "rgba",
  "hsl",
  "hsla",
  "hwb",
  "lab",
  "lch",
  "oklab",
  "oklch",
  "color",
  "device-cmyk",
]);
const palette =
  /(?:^|:)(?:[\w-]+-)?(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d+(?:\/.*)?$/;

/** CSS complements Biome's JSX rules: literal colors belong only in @theme. */
export function checkCss(source: string, file: string): string[] {
  const errors: string[] = [];
  const root = postcss.parse(source, { from: file });
  root.walkAtRules("apply", (rule) => {
    for (const utility of rule.params.split(/\s+/)) {
      if (/[[\]]|-\(/.test(utility) || palette.test(utility)) {
        errors.push(
          `${file}:${rule.source?.start?.line}: @apply must use token utilities: ${utility}`,
        );
      }
    }
  });
  root.walkDecls((declaration) => {
    let parent: AnyNode | undefined = declaration.parent;
    while (parent) {
      if (parent.type === "atrule" && parent.name === "theme") return;
      parent = parent.parent;
    }
    valueParser(declaration.value).walk((node) => {
      // Strings and URL payloads aren't CSS color values.
      if (node.type === "function" && node.value.toLowerCase() === "url")
        return false;
      const value = node.value.toLowerCase();
      if (
        (node.type === "function" && colorFunctions.has(value)) ||
        (node.type === "word" &&
          (/^#[\da-f]{3,8}$/i.test(value) || Object.hasOwn(colors, value)))
      ) {
        errors.push(
          `${file}:${declaration.source?.start?.line}: raw color outside @theme: ${node.value}`,
        );
      }
    });
  });
  return errors;
}
