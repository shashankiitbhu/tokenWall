import * as ts from 'typescript';

export class CodeCompressor {
  /**
   * Scans a prompt for JS/TS code blocks and `<file_content>` blocks,
   * parses them into an AST, aggressively skeletonizes large function bodies,
   * strips comments, and replaces the block with beautifully formatted sparsified code.
   */
  static compress(prompt: string): string {
    // Match Markdown code blocks (```javascript, ```js, ```typescript, ```ts)
    const mdBlockRegex = /```(javascript|js|typescript|ts)\s*([\s\S]*?)\s*```/gi;
    
    // Match XML file_content blocks with .js, .ts, .jsx, .tsx extensions
    const xmlBlockRegex = /<file_content[^>]*path="[^"]+\.(js|ts|jsx|tsx)"[^>]*>\s*([\s\S]*?)\s*<\/file_content>/gi;

    let optimized = prompt.replace(mdBlockRegex, (match, lang, code) => {
      try {
        const sparsified = this.sparsifyCode(code);
        return `\`\`\`${lang}\n${sparsified}\n\`\`\``;
      } catch (e) {
        // Fallback to original if parsing fails
        return match;
      }
    });

    optimized = optimized.replace(xmlBlockRegex, (match, ext, code) => {
      try {
        const sparsified = this.sparsifyCode(code);
        // Replace only the inner code content, keep the XML tags intact
        return match.replace(code, `\n${sparsified}\n`);
      } catch (e) {
        return match;
      }
    });

    return optimized;
  }

  /**
   * Parses the code, skeletonizes it, and prints it out.
   */
  private static sparsifyCode(code: string): string {
    const sourceFile = ts.createSourceFile(
      'temp.ts',
      code,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );

    const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
      const visit: ts.Visitor = (node) => {
        // Skeletonize large functions/methods
        if (
          ts.isFunctionDeclaration(node) ||
          ts.isMethodDeclaration(node) ||
          ts.isArrowFunction(node)
        ) {
          if (node.body && ts.isBlock(node.body)) {
            // Calculate approximate lines
            const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line;
            const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line;
            const lineCount = endLine - startLine;

            if (lineCount > 10) {
              // Replace the body with a stub
              const stubComment = ts.factory.createJSDocComment(
                ' [TokenWall: Function body sparsified] '
              );
              
              const stubBody = ts.factory.createBlock(
                [ts.factory.createEmptyStatement()],
                true // multiline
              );
              
              // We inject the comment synthetically. However, factory methods 
              // for updating nodes are safer.
              ts.addSyntheticLeadingComment(
                stubBody,
                ts.SyntaxKind.MultiLineCommentTrivia,
                ' [TokenWall: Function body sparsified] ',
                true
              );

              if (ts.isFunctionDeclaration(node)) {
                return ts.factory.updateFunctionDeclaration(
                  node,
                  node.modifiers,
                  node.asteriskToken,
                  node.name,
                  node.typeParameters,
                  node.parameters,
                  node.type,
                  stubBody
                );
              } else if (ts.isMethodDeclaration(node)) {
                return ts.factory.updateMethodDeclaration(
                  node,
                  node.modifiers,
                  node.asteriskToken,
                  node.name,
                  node.questionToken,
                  node.typeParameters,
                  node.parameters,
                  node.type,
                  stubBody
                );
              } else if (ts.isArrowFunction(node)) {
                return ts.factory.updateArrowFunction(
                  node,
                  node.modifiers,
                  node.typeParameters,
                  node.parameters,
                  node.type,
                  node.equalsGreaterThanToken,
                  stubBody
                );
              }
            }
          }
        }
        return ts.visitEachChild(node, visit, context);
      };
      return (node) => ts.visitNode(node, visit) as ts.SourceFile;
    };

    const result = ts.transform(sourceFile, [transformer]);
    const transformedSourceFile = result.transformed[0];

    const printer = ts.createPrinter({
      removeComments: true, // Sparsification: remove noisy comments/JSDoc
      newLine: ts.NewLineKind.LineFeed,
    });

    const printed = printer.printFile(transformedSourceFile);
    result.dispose();

    return printed;
  }
}
