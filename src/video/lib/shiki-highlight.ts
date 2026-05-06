/**
 * Shiki syntax highlighting utility for CodeBlock.
 *
 * Runs in Node.js (calculateMetadata) — NOT in browser/Remotion render.
 * Produces CodeLine[] that CodeBlock renders as styled spans.
 */

import type { CodeLine } from "../components/media/CodeBlock";

/**
 * Highlight code using Shiki and return an array of CodeLine objects.
 * Must be called in calculateMetadata (Node.js context).
 */
export async function highlightCode(
  code: string,
  language: string = "typescript",
  theme: string = "github-dark",
): Promise<CodeLine[]> {
  const { codeToHtml } = await import("shiki");

  // Shiki outputs a <pre><code>...lines...</code></pre> structure.
  // Extract individual line content from the HTML.
  const lines = code.split("\n");

  // Re-highlight per-line for individual line control
  const result: CodeLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const lineHtml = await codeToHtml(lines[i] || " ", {
      lang: language,
      theme,
    });
    // Strip the outer <pre><code> wrapper, keep inner spans
    const inner = lineHtml
      .replace(/<pre[^>]*><code[^>]*>/, "")
      .replace(/<\/code><\/pre>/, "")
      .replace(/<span class="line">/, "")
      .replace(/<\/span>$/, "");

    result.push({ html: inner, lineNumber: i + 1 });
  }

  return result;
}
