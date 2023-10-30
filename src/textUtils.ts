export const json = JSON.stringify;

/**
 * Capitalize the first character.
 */
export const ucfirst = (value: string) =>
  value.slice(0, 1).toUpperCase() + value.slice(1);

/**
 * Convert to a camel-case starting with uppercase.
 *
 * Example: `one two three` => `OneTwoThree`
 */
export const upperCamelize = (name: string) =>
  name
    .split(/[^a-zA-Z0-9]+/g)
    .filter((x) => x)
    .map((v) => ucfirst(v))
    .join("");

/**
 * Add a prefix to every line in some text.
 */
export const indent = (
  prefix: string,
  text: string,
  includeEmptyLines = false,
): string =>
  text
    .split("\n")
    .map((line: string) => (line || includeEmptyLines ? prefix + line : line))
    .join("\n");

/**
 * Basic templating rendering.
 *
 * String values in `vars` will be used for simple substitution
 * of `@@KEY@@`, while boolean values will be used for
 * conditional sections of code between `#@@ IF KEY` and `#@@
 * ENDIF KEY`.
 */
export const renderTmpl = (
  tmpl: string,
  vars: { [name: string]: string | boolean },
): string => {
  let result = tmpl;
  for (const [name, value] of Object.entries(vars)) {
    if (typeof value === "string") {
      result = result.replace(new RegExp(`@@${name}@@`, "g"), value);
    }
    if (typeof value === "boolean") {
      while (true) {
        const lines = result.split("\n");
        const startIdx = lines.indexOf(`#@@ IF ${name}`);
        const endIdx = lines.indexOf(`#@@ ENDIF ${name}`);
        if (startIdx === -1 || endIdx < startIdx) {
          break;
        }
        if (value) {
          lines.splice(endIdx, 1);
          lines.splice(startIdx, 1);
        } else {
          lines.splice(startIdx, endIdx - startIdx + 1);
        }
        result = lines.join("\n");
      }
    }
  }
  return result;
};
