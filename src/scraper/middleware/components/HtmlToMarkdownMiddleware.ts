// @ts-ignore
import { gfm } from "@joplin/turndown-plugin-gfm";
import TurndownService from "turndown";
import { logger } from "../../../utils/logger"; // Added logger
import type { ContentProcessingContext, ContentProcessorMiddleware } from "../types";

/**
 * Middleware to convert the final processed HTML content (from Cheerio object in context.dom)
 * into Markdown using Turndown, applying custom rules.
 */
export class HtmlToMarkdownMiddleware implements ContentProcessorMiddleware {
  private turndownService: TurndownService;

  constructor() {
    this.turndownService = new TurndownService({
      headingStyle: "atx",
      hr: "---",
      bulletListMarker: "-",
      codeBlockStyle: "fenced",
      emDelimiter: "_",
      strongDelimiter: "**",
      linkStyle: "inlined",
    });

    this.turndownService.use(gfm);

    this.addCustomRules();
  }

  private addCustomRules(): void {
    // Preserve code blocks and syntax (replicated from HtmlProcessor)
    this.turndownService.addRule("pre", {
      filter: ["pre"],
      replacement: (content, node) => {
        const element = node as unknown as HTMLElement;
        let language = element.getAttribute("data-language") || "";
        if (!language) {
          // Try to infer the language from the class name
          // This is a common pattern in syntax highlighters
          const highlightElement =
            element.closest(
              '[class*="highlight-source-"], [class*="highlight-"], [class*="language-"]',
            ) ||
            element.querySelector(
              '[class*="highlight-source-"], [class*="highlight-"], [class*="language-"]',
            );
          if (highlightElement) {
            const className = highlightElement.className;
            const match = className.match(
              /(?:highlight-source-|highlight-|language-)(\w+)/,
            );
            if (match) language = match[1];
          }
        }

        for (const br of Array.from(element.querySelectorAll("br"))) {
          br.replaceWith("\n");
        }

        const text = element.textContent || "";

        return `\n\`\`\`${language}\n${text.replace(/^\n+|\n+$/g, "")}\n\`\`\`\n`;
      },
    });
  }

  /**
   * Processes the context to convert the sanitized HTML body node to Markdown.
   * @param context The current processing context.
   * @param next Function to call the next middleware.
   */
  async process(
    context: ContentProcessingContext,
    next: () => Promise<void>,
  ): Promise<void> {
    // Check if we have a Cheerio object from a previous step
    const $ = context.dom;
    if (!$) {
      // Log a warning if running on HTML content without a DOM
      if (context.contentType.startsWith("text/html")) {
        logger.warn(
          `Skipping ${this.constructor.name}: context.dom is missing for HTML content. Ensure HtmlCheerioParserMiddleware ran correctly.`,
        );
      }
      // Otherwise, just proceed (might be non-HTML content or error state)
      await next();
      return;
    }

    // Only process if we have a Cheerio object (implicitly means it's HTML)
    try {
      logger.debug(`Converting HTML content to Markdown for ${context.source}`);
      // Provide Turndown with the HTML string content from the Cheerio object's body,
      // or the whole document if body is empty/unavailable.
      const htmlToConvert = $("body").html() || $.html();
      const markdown = this.turndownService.turndown(htmlToConvert).trim();

      if (!markdown) {
        // If conversion results in empty markdown, log a warning but treat as valid empty markdown
        const warnMsg = `HTML to Markdown conversion resulted in empty content for ${context.source}.`;
        logger.warn(warnMsg);
        // Set content to empty string and update type, do not add error
        context.content = "";
        context.contentType = "text/markdown";
      } else {
        // Conversion successful and produced non-empty markdown
        context.content = markdown;
        context.contentType = "text/markdown"; // Update content type
        logger.debug(`Successfully converted HTML to Markdown for ${context.source}`);
      }
    } catch (error) {
      logger.error(`Error converting HTML to Markdown for ${context.source}: ${error}`);
      context.errors.push(
        new Error(
          `Failed to convert HTML to Markdown: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      // Decide if pipeline should stop? For now, continue.
    }

    // Call the next middleware in the chain regardless of whether conversion happened
    await next();

    // No need to close/free Cheerio object explicitly
    // context.dom = undefined; // Optionally clear the dom property if no longer needed downstream
  }
}
