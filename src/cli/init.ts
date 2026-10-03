import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CASES_TEMPLATE, CONFIG_TEMPLATE, PLANTED_TEMPLATE } from "./templates.ts";

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

/** Writes the starter files, never overwriting one that exists. */
export async function initCommand(dir: string): Promise<number> {
  const files: [string, string][] = [
    ["noxeval.config.mjs", CONFIG_TEMPLATE],
    ["noxeval.cases.json", JSON.stringify(CASES_TEMPLATE, null, 2) + "\n"],
    ["noxeval.planted.json", JSON.stringify(PLANTED_TEMPLATE, null, 2) + "\n"],
  ];
  for (const [name, content] of files) {
    const path = join(dir, name);
    if (await exists(path)) console.log(`skip    ${name} (already exists)`);
    else {
      await writeFile(path, content);
      console.log(`create  ${name}`);
    }
  }
  console.log("\nNext: point the target in noxeval.config.mjs at your app, then run: npx noxeval run");
  return 0;
}
