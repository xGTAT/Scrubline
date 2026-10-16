import postcss from 'postcss';
import * as parse5 from 'parse5';
import type { HistoryStore } from '../store/store';
import type { RenderCache } from '../preview/cache';
import type { Checkpoint } from '../bridge/timeline';
import { changedPaths } from '../capture/scanner';
import { declarationChanges, type CssUnit } from '../investigation/change-units';
import { redact } from '../targeting/redact';
import type { DesignQueryContext, VisualEvidenceStatus } from './types';

function isFrontendFile(filePath: string): boolean {
  const ext = filePath.toLowerCase().split('.').pop() ?? '';
  return ['html', 'htm', 'css', 'scss', 'less', 'jsx', 'tsx', 'vue', 'svelte', 'svg'].includes(ext);
}

interface Parse5Attr {
  name: string;
  value: string;
}

interface Parse5Node {
  nodeName?: string;
  tagName?: string;
  attrs?: Parse5Attr[];
  value?: string;
  childNodes?: Parse5Node[];
}

function parseHtmlElements(htmlContent: string) {
  const elements: DesignQueryContext['htmlElements'] = [];
  try {
    const document = parse5.parse(htmlContent) as Parse5Node;
    function traverse(node: Parse5Node) {
      if (node.tagName) {
        const attrs: Record<string, string> = {};
        if (Array.isArray(node.attrs)) {
          for (const attr of node.attrs) {
            attrs[attr.name] = attr.value;
          }
        }
        elements.push({
          tag: node.tagName.toLowerCase(),
          id: attrs.id,
          classes: (attrs.class || '').split(/\s+/).filter(Boolean),
          role: attrs.role,
          ariaLabel: attrs['aria-label'] || attrs['aria-labelledby'],
          textSnippet: node.childNodes
            ?.filter((c) => c.nodeName === '#text')
            ?.map((c) => c.value?.trim())
            ?.filter(Boolean)
            ?.join(' ')
            ?.slice(0, 80)
        });
      }
      if (node.childNodes && elements.length < 500) {
        for (const child of node.childNodes) {
          traverse(child);
        }
      }
    }
    traverse(document);
  } catch {
    // Gracefully handle malformed markup
  }
  return elements;
}

function parseCssDeclarations(filePath: string, cssContent: string) {
  const declarations: DesignQueryContext['cssDeclarations'] = [];
  try {
    const root = postcss.parse(cssContent);
    root.walkDecls((decl) => {
      if (decl.parent?.type === 'rule' && declarations.length < 1000) {
        declarations.push({
          path: filePath,
          selector: decl.parent.selector,
          property: decl.prop.toLowerCase(),
          value: decl.value.trim() + (decl.important ? ' !important' : '')
        });
      }
    });
  } catch {
    // Gracefully handle CSS parsing errors
  }
  return declarations;
}

export async function assembleChatbotContext(
  store: HistoryStore,
  activeCheckpoint: Checkpoint,
  userQuery: string,
  options: {
    compareCheckpoint?: Checkpoint;
    cache?: RenderCache;
    secrets?: readonly string[];
  } = {}
): Promise<DesignQueryContext> {
  const secrets = options.secrets ?? [];
  const compareCheckpoint = options.compareCheckpoint;
  const frontendFiles = activeCheckpoint.files.filter((f) => isFrontendFile(f.path));

  const targetFiles: DesignQueryContext['targetFiles'] = [];
  const cssDeclarations: DesignQueryContext['cssDeclarations'] = [];
  const htmlElements: DesignQueryContext['htmlElements'] = [];

  for (const file of frontendFiles.slice(0, 30)) {
    try {
      const rawBuffer = await store.readBlob(file.hash);
      const rawText = rawBuffer.toString('utf8');
      const sanitizedText = redact(rawText, secrets);

      const isHtml = file.path.endsWith('.html') || file.path.endsWith('.htm');
      const isCss = file.path.endsWith('.css');

      targetFiles.push({
        path: file.path,
        content: sanitizedText,
        isHtml,
        isCss
      });

      if (isCss) {
        cssDeclarations.push(...parseCssDeclarations(file.path, sanitizedText));
      } else if (isHtml) {
        htmlElements.push(...parseHtmlElements(sanitizedText));
      }
    } catch {
      // Ignore unreadable or corrupt file blobs
    }
  }

  let cssChanges: CssUnit[] | undefined;
  if (compareCheckpoint) {
    const changes: CssUnit[] = [];
    const changed = changedPaths(compareCheckpoint.files, activeCheckpoint.files).filter((p) =>
      p.endsWith('.css')
    );

    for (const p of changed) {
      const oldFile = compareCheckpoint.files.find((f) => f.path === p);
      const newFile = activeCheckpoint.files.find((f) => f.path === p);
      if (oldFile && newFile) {
        try {
          const oldText = (await store.readBlob(oldFile.hash)).toString('utf8');
          const newText = (await store.readBlob(newFile.hash)).toString('utf8');
          changes.push(...declarationChanges(p, oldText, newText));
        } catch {
          // Continue if diff fails
        }
      }
    }
    cssChanges = changes;
  }

  const visual: VisualEvidenceStatus = {
    hasScreenshot: false,
    hasRegions: false,
    regionCount: 0,
    hasReceipt: false,
    limitations: []
  };

  if (options.cache) {
    try {
      const screenshot = await options.cache.get(activeCheckpoint.id);
      if (screenshot) {
        visual.hasScreenshot = true;
        visual.screenshotPath = screenshot;
      }
      const regions = await options.cache.regions(activeCheckpoint.id);
      if (regions && regions.length > 0) {
        visual.hasRegions = true;
        visual.regionCount = regions.length;
      }
      const receipt = await options.cache.receipt(activeCheckpoint.id);
      if (receipt) {
        visual.hasReceipt = true;
        visual.receipt = receipt;
      }
    } catch {
      // Cache reading failed
    }
  }

  if (!visual.hasScreenshot) {
    visual.limitations.push(
      'No rendered screenshot available for this checkpoint. Recommendations are based on static source code and CSS heuristics only.'
    );
  }
  if (!visual.hasRegions) {
    visual.limitations.push(
      'No element layout regions measured. Runtime element dimensions and bounding boxes cannot be verified.'
    );
  }

  return {
    activeCheckpoint,
    compareCheckpoint,
    targetFiles,
    cssDeclarations,
    cssChanges,
    htmlElements,
    visual,
    userQuery: redact(userQuery, secrets)
  };
}
