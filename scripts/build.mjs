import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "dist");
const rel = relative(root, output);
if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Diretório de publicação fora do projeto.");

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const file of ["index.html", "app.js", "styles.css"]) await copyFile(join(root, file), join(output, file));
console.log("Publicação Netlify preparada em dist/ (somente arquivos públicos do painel).");
