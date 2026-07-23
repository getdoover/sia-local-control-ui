import * as fs from "fs";
import * as path from "path";
import type { Compiler, Compilation } from "webpack";

interface Options {
  source?: string;
  destination: string;
  name: string;
  ignore?: string[];
}

export default class ConcatenatePlugin {
  readonly source: string;
  readonly destination: string;
  readonly name: string;
  readonly ignore: string[];

  constructor(options: Options) {
    this.source = options.source ?? "./dist";
    this.destination = path.resolve(options.destination);
    this.name = options.name;
    this.ignore = options.ignore ?? [];
  }

  apply(compiler: Compiler): void {
    compiler.hooks.afterEmit.tapAsync(
      "ConcatenatePlugin",
      (_compilation: Compilation, callback: (error?: Error | null) => void) => {
        try {
          const sourceDir = path.resolve(this.source);
          const files = this.findJsFiles(sourceDir);
          if (files.length === 0) {
            throw new Error(`No widget JavaScript emitted under ${sourceDir}`);
          }
          fs.mkdirSync(this.destination, { recursive: true });
          fs.writeFileSync(
            path.join(this.destination, this.name),
            files.map((file) => fs.readFileSync(file, "utf8")).join("\n"),
          );
          callback();
        } catch (error) {
          callback(error as Error);
        }
      },
    );
  }

  private findJsFiles(directory: string): string[] {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .flatMap((entry) => {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) return this.findJsFiles(file);
        return path.extname(entry.name) === ".js" && !this.ignore.includes(entry.name)
          ? [file]
          : [];
      })
      .sort();
  }
}
