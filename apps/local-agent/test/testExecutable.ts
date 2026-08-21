import { chmod, writeFile } from "node:fs/promises";

export async function writeNodeTestExecutable(
  commandPath: string,
  source: string,
  _encoding: BufferEncoding = "utf8",
): Promise<void> {
  if (process.platform === "win32") {
    const sourcePath = `${commandPath}.js`;
    await writeFile(sourcePath, source, "utf8");
    await writeFile(
      `${commandPath}.cmd`,
      `@echo off\r\n"${process.execPath}" "${sourcePath}" %*\r\n`,
      "utf8",
    );
    return;
  }

  await writeFile(commandPath, source, "utf8");
  await chmod(commandPath, 0o755);
}
