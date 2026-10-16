import { contrastRatio, parseColor } from './contrast';
import type {
  DesignQueryContext,
  DesignAdviceResponse,
  DesignRecommendation,
  DesignAnalysisFinding,
  EvidenceItem
} from './types';

interface QueryIntent {
  isClutterOrSpacing: boolean;
  isHierarchyOrTypography: boolean;
  isNavigation: boolean;
  isVersionDiff: boolean;
  isConsistency: boolean;
  isProfessionalPolish: boolean;
  isPrioritization: boolean;
}

export function detectQueryIntent(query: string): QueryIntent {
  const q = query.toLowerCase();
  return {
    isClutterOrSpacing:
      q.includes('clutter') ||
      q.includes('spacing') ||
      q.includes('margin') ||
      q.includes('padding') ||
      q.includes('crowded') ||
      q.includes('cramped') ||
      q.includes('gap') ||
      q.includes('breath'),
    isHierarchyOrTypography:
      q.includes('hierarchy') ||
      q.includes('typography') ||
      q.includes('font') ||
      q.includes('heading') ||
      q.includes('readab') ||
      q.includes('text') ||
      q.includes('weight'),
    isNavigation:
      q.includes('nav') ||
      q.includes('sidebar') ||
      q.includes('top bar') ||
      q.includes('header') ||
      q.includes('menu'),
    isVersionDiff:
      q.includes('change') ||
      q.includes('between') ||
      q.includes('previous') ||
      q.includes('version') ||
      q.includes('diff') ||
      q.includes('compare') ||
      q.includes('earlier') ||
      q.includes('which version'),
    isConsistency:
      q.includes('consist') ||
      q.includes('match') ||
      q.includes('uniform') ||
      q.includes('token') ||
      q.includes('color'),
    isProfessionalPolish:
      q.includes('professional') ||
      q.includes('polish') ||
      q.includes('modern') ||
      q.includes('look better') ||
      q.includes('improve'),
    isPrioritization:
      q.includes('priorit') ||
      q.includes('first') ||
      q.includes('greatest') ||
      q.includes('most important') ||
      q.includes('quickest')
  };
}

export class DesignAnalyzer {
  analyze(context: DesignQueryContext): DesignAdviceResponse {
    const intent = detectQueryIntent(context.userQuery);
    const findings: DesignAnalysisFinding[] = [];
    const recommendations: DesignRecommendation[] = [];
    const disclaimers: string[] = [];
    const snippets: DesignAdviceResponse['suggestedSnippets'] = [];

    if (!context.visual.hasScreenshot) {
      disclaimers.push(
        'Visual evaluation note: No rendered screenshot is available for this version. Judgments are based on CSS rules, HTML hierarchy, and layout heuristics rather than pixel-level visual rendering.'
      );
    }

    // Run analyzers
    this.analyzeSpacing(context, findings, recommendations, snippets);
    this.analyzeTypography(context, findings, recommendations, snippets);
    this.analyzeNavigation(context, findings, recommendations, snippets);
    this.analyzeConsistency(context, findings, recommendations, snippets);
    this.analyzeContrast(context, findings, recommendations);

    if (context.compareCheckpoint || intent.isVersionDiff) {
      this.analyzeDiff(context, findings, recommendations);
    }

    // Determine direct answer and summary based on user query
    const summary = this.buildSummary(intent, findings, recommendations, context);
    const directAnswer = this.buildDirectAnswer(intent, findings, recommendations, context);

    // Filter or re-order recommendations by priority
    if (intent.isPrioritization) {
      recommendations.sort((a, b) => {
        const pMap = { high: 0, medium: 1, low: 2 };
        return pMap[a.priority] - pMap[b.priority];
      });
    }

    return {
      id: `adv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      query: context.userQuery,
      checkpointId: context.activeCheckpoint.id,
      compareCheckpointId: context.compareCheckpoint?.id,
      summary,
      directAnswer,
      findings,
      recommendations,
      visualEvidence: context.visual,
      disclaimers,
      suggestedSnippets: snippets
    };
  }

  private analyzeSpacing(
    context: DesignQueryContext,
    findings: DesignAnalysisFinding[],
    recommendations: DesignRecommendation[],
    snippets: DesignAdviceResponse['suggestedSnippets']
  ) {
    const spacingDecls = context.cssDeclarations.filter((d) =>
      [
        'margin',
        'margin-top',
        'margin-bottom',
        'margin-left',
        'margin-right',
        'padding',
        'padding-top',
        'padding-bottom',
        'gap'
      ].includes(d.property)
    );

    const negativeMargins = spacingDecls.filter((d) => d.value.startsWith('-'));
    if (negativeMargins.length > 0) {
      const first = negativeMargins[0];
      const evidence: EvidenceItem[] = [
        {
          category: 'css_ast',
          file: first.path,
          selector: first.selector,
          property: first.property,
          value: first.value,
          description: `Found negative margin declaration: ${first.selector} { ${first.property}: ${first.value}; }`,
          verified: true
        }
      ];
      findings.push({
        type: 'issue',
        category: 'spacing',
        title: 'Negative margins detected',
        details: `Negative margins (${first.selector}: ${first.value}) often indicate brittle layout offsets that lead to overlapping content on different screen sizes.`,
        evidence
      });
      recommendations.push({
        id: 'rec-spacing-negative',
        category: 'spacing',
        priority: 'high',
        title: 'Replace negative margins with standard flex/grid flow or padding',
        description: `Eliminate negative margin on '${first.selector}'. Use 'gap' on the parent container or adjust sibling padding to position elements cleanly without risk of overlap.`,
        rationale:
          'Avoids unintended element collisions across different viewport widths and zoom settings.',
        tradeOffs: 'May require adjusting the parent container layout or wrapper margins.',
        suggestedCode: `${first.selector} {\n  /* Replace ${first.property}: ${first.value}; */\n  ${first.property}: 0;\n}`,
        targetFile: first.path,
        evidence
      });
    }

    const flexWithoutGap = context.cssDeclarations.filter(
      (d) => d.property === 'display' && (d.value === 'flex' || d.value === 'inline-flex')
    );
    const gapDecls = new Set(
      context.cssDeclarations
        .filter(
          (d) => d.property === 'gap' || d.property === 'row-gap' || d.property === 'column-gap'
        )
        .map((d) => d.selector)
    );
    const unspacedContainers = flexWithoutGap.filter((d) => !gapDecls.has(d.selector));

    if (unspacedContainers.length > 0) {
      const item = unspacedContainers[0];
      const evidence: EvidenceItem[] = [
        {
          category: 'css_ast',
          file: item.path,
          selector: item.selector,
          property: 'display',
          value: item.value,
          description: `Flex container '${item.selector}' has no explicit 'gap' declaration.`,
          verified: true
        }
      ];
      findings.push({
        type: 'observation',
        category: 'spacing',
        title: `Flex container '${item.selector}' lacks explicit gap`,
        details: `Elements inside '${item.selector}' rely on margin hacks or touch directly, which can cause uneven rhythm.`,
        evidence
      });
      recommendations.push({
        id: 'rec-flex-gap',
        category: 'spacing',
        priority: 'medium',
        title: `Add uniform 'gap' to flex container '${item.selector}'`,
        description: `Define 'gap: 12px' or 'gap: 16px' directly on '${item.selector}' to create consistent breathing room between child elements.`,
        rationale:
          'Ensures consistent gutters between items without manual margin calculations on children.',
        tradeOffs: 'Requires removing child margins to avoid doubling the intended space.',
        suggestedCode: `${item.selector} {\n  display: flex;\n  gap: 12px; /* Adjust according to density */\n}`,
        targetFile: item.path,
        evidence
      });
      snippets.push({
        title: `Consistent Spacing for ${item.selector}`,
        language: 'css',
        code: `${item.selector} {\n  display: flex;\n  gap: 16px;\n  align-items: center;\n}`,
        targetFile: item.path
      });
    }
  }

  private analyzeTypography(
    context: DesignQueryContext,
    findings: DesignAnalysisFinding[],
    recommendations: DesignRecommendation[],
    _snippets: DesignAdviceResponse['suggestedSnippets']
  ) {
    const headings = context.htmlElements.filter((e) => /^h[1-6]$/.test(e.tag));
    if (headings.length > 1) {
      const levels = headings.map((h) => parseInt(h.tag[1], 10));
      let skippedLevel = false;
      for (let i = 0; i < levels.length - 1; i++) {
        if (levels[i + 1] - levels[i] > 1) {
          skippedLevel = true;
          break;
        }
      }
      if (skippedLevel) {
        const evidence: EvidenceItem[] = [
          {
            category: 'html_structure',
            description: `Heading structure jumps levels: ${headings.map((h) => `<${h.tag}>`).join(' -> ')}`,
            verified: true
          }
        ];
        findings.push({
          type: 'issue',
          category: 'visual_hierarchy',
          title: 'Heading rank skipped in document structure',
          details:
            'Headings should follow a sequential descent (h1 -> h2 -> h3). Skipping ranks disrupts screen readers and weakens the visual hierarchy.',
          evidence
        });
        recommendations.push({
          id: 'rec-heading-sequence',
          category: 'visual_hierarchy',
          priority: 'medium',
          title: 'Preserve sequential heading levels',
          description:
            'Ensure headings descend sequentially without skipping levels. Use CSS font size utilities if a lower-rank heading needs smaller styling.',
          rationale:
            'Improves accessibility navigation and maintains predictable document hierarchy.',
          tradeOffs: 'May require updating CSS selectors tied to specific tag names.',
          evidence
        });
      }
    }

    const fontSizes = context.cssDeclarations.filter((d) => d.property === 'font-size');
    const pxSizes = fontSizes
      .map((d) => ({ ...d, num: parseFloat(d.value) }))
      .filter((d) => !isNaN(d.num) && d.value.endsWith('px'));

    if (pxSizes.length > 5) {
      const unique = [...new Set(pxSizes.map((p) => p.num))].sort((a, b) => a - b);
      const closePairs: [number, number][] = [];
      for (let i = 0; i < unique.length - 1; i++) {
        if (unique[i + 1] - unique[i] === 1) {
          closePairs.push([unique[i], unique[i + 1]]);
        }
      }
      if (closePairs.length > 0) {
        const pair = closePairs[0];
        const evidence: EvidenceItem[] = [
          {
            category: 'css_ast',
            description: `Multiple closely matched font sizes found (${pair[0]}px and ${pair[1]}px).`,
            verified: true
          }
        ];
        findings.push({
          type: 'observation',
          category: 'typography',
          title: `Indistinguishable font sizes (${pair[0]}px vs ${pair[1]}px)`,
          details: `Font sizes differing by only 1px create visual ambiguity rather than clear hierarchy. Users cannot easily tell which text is more prominent.`,
          evidence
        });
        recommendations.push({
          id: 'rec-type-scale',
          category: 'typography',
          priority: 'medium',
          title: 'Adopt a distinct typographic scale',
          description: `Consolidate ${pair[0]}px and ${pair[1]}px into a single type tier or increase the size delta to at least 3-4px (e.g. 14px -> 18px -> 24px).`,
          rationale:
            'Creates clear, unambiguous visual contrast between body text, labels, and headings.',
          tradeOffs: 'May require slight adjustments to container heights and padding.',
          suggestedCode: `:root {\n  --font-size-sm: 13px;\n  --font-size-base: 15px;\n  --font-size-lg: 18px;\n  --font-size-xl: 22px;\n}`,
          evidence
        });
      }
    }
  }

  private analyzeNavigation(
    context: DesignQueryContext,
    findings: DesignAnalysisFinding[],
    recommendations: DesignRecommendation[],
    _snippets: DesignAdviceResponse['suggestedSnippets']
  ) {
    const navElements = context.htmlElements.filter(
      (e) => e.tag === 'nav' || e.classes.some((c) => c.includes('nav') || c.includes('sidebar'))
    );
    const navLinks = context.htmlElements.filter((e) => e.tag === 'a');

    const sidebarDecls = context.cssDeclarations.filter(
      (d) =>
        d.selector.includes('sidebar') ||
        d.selector.includes('aside') ||
        (d.property === 'flex-direction' && d.value === 'column')
    );

    const isSidebarPresent =
      sidebarDecls.length > 0 || navElements.some((e) => e.classes.includes('sidebar'));

    findings.push({
      type: 'observation',
      category: 'layout',
      title: isSidebarPresent
        ? 'Sidebar navigation pattern detected'
        : 'Top/horizontal navigation pattern detected',
      details: isSidebarPresent
        ? `The layout currently organizes navigation vertically in a sidebar. This reserves dedicated horizontal width (${navLinks.length} links tracked).`
        : `The layout currently uses top/horizontal navigation. This maximizes content width across wide screens.`,
      evidence: [
        {
          category: 'html_structure',
          description: `Detected navigation container with ${navLinks.length} links. Pattern: ${isSidebarPresent ? 'Sidebar' : 'Top bar'}.`,
          verified: true
        }
      ]
    });

    recommendations.push({
      id: 'rec-nav-choice',
      category: 'layout',
      priority: 'low',
      title: isSidebarPresent
        ? 'Evaluate if Top Navigation Bar provides better content width'
        : 'Evaluate whether a Sidebar would better scale your navigation',
      description: isSidebarPresent
        ? `If your page has fewer than 6 primary sections, a top navigation bar saves 200-240px of horizontal space, making data tables, wide previews, and dashboards feel less cramped.`
        : `If your page expands beyond 6-7 items or requires multi-level grouping, a sidebar offers clearer categorization and faster vertical scanning.`,
      rationale: isSidebarPresent
        ? 'Top nav frees up width for detailed content and unifies desktop and mobile mental models.'
        : 'Sidebar allows deep scrolling navigation without wrapping header rows.',
      tradeOffs: isSidebarPresent
        ? 'Top nav has limited horizontal capacity; dropdowns or overflow menus become necessary if links increase.'
        : 'Sidebar takes fixed horizontal width, reducing room for wide panels or split editors.',
      suggestedCode: isSidebarPresent
        ? `/* Alternative Top Navigation Bar */\n.nav-header {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  padding: 12px 24px;\n  border-bottom: 1px solid var(--vscode-panel-border, #333);\n}`
        : `/* Alternative Sidebar Navigation */\n.sidebar-nav {\n  display: flex;\n  flex-direction: column;\n  width: 220px;\n  padding: 16px 8px;\n  border-right: 1px solid var(--vscode-panel-border, #333);\n}`,
      evidence: []
    });
  }

  /**
   * Advisory color-clash heuristic: flags selector rules whose literal text
   * and background colors fall below the WCAG 4.5:1 contrast guideline.
   * Only literal colors resolve; gradients, var(), inheritance and opacity
   * are not modeled, so findings are advisory, never verdicts.
   */
  private analyzeContrast(
    context: DesignQueryContext,
    findings: DesignAnalysisFinding[],
    recommendations: DesignRecommendation[]
  ) {
    const byRule = new Map<string, { path: string; color?: string; background?: string }>();
    for (const d of context.cssDeclarations) {
      const key = `${d.path}::${d.selector}`;
      const entry = byRule.get(key) ?? { path: d.path };
      if (d.property === 'color') entry.color = d.value;
      if (d.property === 'background-color' || d.property === 'background')
        entry.background = d.value;
      byRule.set(key, entry);
    }
    let flagged = 0;
    for (const [key, entry] of byRule) {
      if (flagged >= 3) break;
      if (!entry.color || !entry.background) continue;
      const fg = parseColor(entry.color);
      const bg = parseColor(entry.background);
      if (!fg || !bg) continue;
      const ratio = contrastRatio(fg, bg);
      if (ratio >= 4.5) continue;
      flagged++;
      const selector = key.split('::')[1];
      findings.push({
        type: 'issue',
        category: 'accessibility',
        title: `Possible low-contrast text on ${selector}`,
        details: `The literal colors ${entry.color} on ${entry.background} measure a ${ratio.toFixed(2)}:1 contrast ratio, below the WCAG 4.5:1 guideline for body text. Advisory heuristic: inheritance, gradients, CSS variables and opacity are not modeled.`,
        evidence: [
          {
            category: 'css_ast',
            file: entry.path,
            selector,
            property: 'color',
            value: entry.color,
            description: `Text color ${entry.color} on background ${entry.background} measures ${ratio.toFixed(2)}:1`,
            verified: true
          }
        ]
      });
      recommendations.push({
        id: `contrast-${flagged}`,
        category: 'accessibility',
        priority: ratio < 3 ? 'high' : 'medium',
        title: `Raise text contrast on ${selector}`,
        description: `Darken the text color or lighten the background for ${selector} toward the 4.5:1 guideline.`,
        rationale: `Measured ${ratio.toFixed(2)}:1 between the literal colors ${entry.color} and ${entry.background}.`,
        tradeOffs: 'Brand palette constraints may justify exceptions for large or decorative text.',
        targetFile: entry.path,
        evidence: []
      });
    }
  }

  private analyzeConsistency(
    context: DesignQueryContext,
    findings: DesignAnalysisFinding[],
    recommendations: DesignRecommendation[],
    _snippets: DesignAdviceResponse['suggestedSnippets']
  ) {
    const colorDecls = context.cssDeclarations.filter(
      (d) =>
        (d.property === 'color' ||
          d.property === 'background-color' ||
          d.property === 'border-color') &&
        (d.value.startsWith('#') || d.value.startsWith('rgb'))
    );

    const varColorDecls = context.cssDeclarations.filter(
      (d) =>
        (d.property === 'color' ||
          d.property === 'background-color' ||
          d.property === 'border-color') &&
        d.value.includes('var(')
    );

    if (colorDecls.length > 3 && varColorDecls.length > 0) {
      const sample = colorDecls[0];
      const evidence: EvidenceItem[] = [
        {
          category: 'css_ast',
          file: sample.path,
          selector: sample.selector,
          property: sample.property,
          value: sample.value,
          description: `Raw color literal '${sample.value}' used instead of theme variable.`,
          verified: true
        }
      ];
      findings.push({
        type: 'issue',
        category: 'color_consistency',
        title: 'Mixed color variables and hardcoded hex/RGB values',
        details: `Detected ${colorDecls.length} hardcoded color values alongside CSS variables. Hardcoded colors do not respect IDE theme switches (light/dark/high contrast).`,
        evidence
      });
      recommendations.push({
        id: 'rec-theme-vars',
        category: 'color_consistency',
        priority: 'high',
        title: 'Replace raw color values with CSS variables or VS Code theme tokens',
        description: `Replace '${sample.value}' in '${sample.selector}' with 'var(--vscode-foreground)' or a semantic project variable.`,
        rationale: 'Ensures seamless theme switching between dark, light, and high-contrast modes.',
        tradeOffs:
          'Requires defining a theme token mapping if external design tokens are not yet set.',
        suggestedCode: `${sample.selector} {\n  /* Replace ${sample.property}: ${sample.value}; */\n  ${sample.property}: var(--vscode-${sample.property === 'color' ? 'foreground' : 'sideBar-background'});\n}`,
        targetFile: sample.path,
        evidence
      });
    }
  }

  private analyzeDiff(
    context: DesignQueryContext,
    findings: DesignAnalysisFinding[],
    recommendations: DesignRecommendation[]
  ) {
    if (context.perfDelta?.length) {
      findings.push({
        type: 'observation',
        category: 'diff_comparison',
        title: 'Performance changes between compared versions',
        details: context.perfDelta
          .map(
            (d) => `${d.label}: ${d.before} -> ${d.after} (${d.delta > 0 ? '+' : ''}${d.delta}).`
          )
          .join(' '),
        evidence: context.perfDelta.slice(0, 5).map((d) => ({
          category: 'historical_diff',
          description: `${d.label} changed from ${d.before} to ${d.after}`,
          value: `${d.delta > 0 ? '+' : ''}${d.delta}`,
          verified: true
        }))
      });
    }
    if (!context.cssChanges || context.cssChanges.length === 0) {
      findings.push({
        type: 'observation',
        category: 'diff_comparison',
        title: 'No CSS declaration changes between compared versions',
        details:
          'The recorded changes between these versions did not alter any CSS properties directly, or changes were limited to HTML/JS files.',
        evidence: []
      });
      return;
    }

    const changes = context.cssChanges;
    const evidence: EvidenceItem[] = changes.slice(0, 5).map((c) => ({
      category: 'historical_diff',
      file: c.path,
      selector: c.selector,
      property: c.property,
      value: `${c.before} -> ${c.after}`,
      description: `Rule '${c.selector}': changed ${c.property} from '${c.before}' to '${c.after}'`,
      verified: true
    }));

    findings.push({
      type: 'observation',
      category: 'diff_comparison',
      title: `${changes.length} CSS layout/styling change${changes.length === 1 ? '' : 's'} recorded`,
      details: `Between version ${context.compareCheckpoint?.id.slice(0, 7) ?? 'base'} and ${context.activeCheckpoint.id.slice(0, 7)}, ${changes.length} style declarations were altered across tracked stylesheets.`,
      evidence
    });

    const layoutChanges = changes.filter((c) =>
      [
        'display',
        'flex-direction',
        'padding',
        'margin',
        'gap',
        'width',
        'grid-template-columns'
      ].includes(c.property)
    );

    if (layoutChanges.length > 0) {
      const topChange = layoutChanges[0];
      recommendations.push({
        id: 'rec-diff-layout',
        category: 'diff_comparison',
        priority: 'medium',
        title: `Review layout delta on '${topChange.selector}'`,
        description: `The change '${topChange.property}: ${topChange.before} -> ${topChange.after}' altered container spacing. Check that surrounding elements maintain consistent alignment.`,
        rationale:
          'Modifications to primary container properties can shift adjacent elements across different viewports.',
        tradeOffs: 'Reverting may re-introduce earlier spacing constraints.',
        targetFile: topChange.path,
        evidence
      });
    }
  }

  private buildDirectAnswer(
    intent: QueryIntent,
    findings: DesignAnalysisFinding[],
    recommendations: DesignRecommendation[],
    context: DesignQueryContext
  ): string {
    if (intent.isClutterOrSpacing) {
      const spacingRecs = recommendations.filter((r) => r.category === 'spacing');
      if (spacingRecs.length > 0) {
        return `The layout presents some spacing friction. Specifically, ${spacingRecs[0].description} Addressing this will provide cleaner gutters and reduce visual crowding.`;
      }
      return 'The page spacing appears reasonably structured based on source rules. To reduce perceived clutter, ensure content sections have at least 16–24px padding and avoid nesting containers without clear margins.';
    }

    if (intent.isNavigation) {
      const navRec = recommendations.find((r) => r.category === 'layout');
      if (navRec) {
        return `${navRec.title}. ${navRec.description}`;
      }
      return 'Both navigation patterns have distinct trade-offs: a top navigation bar maximizes content width and suits < 6 links, whereas a sidebar provides clear grouping for deep menus at the cost of 200–240px horizontal width.';
    }

    if (intent.isVersionDiff) {
      if (context.cssChanges && context.cssChanges.length > 0) {
        return `Between these versions, ${context.cssChanges.length} CSS declarations changed. The primary layout change was in '${context.cssChanges[0].selector}' (${context.cssChanges[0].property}: ${context.cssChanges[0].before} -> ${context.cssChanges[0].after}).`;
      }
      return 'Between these recorded versions, no direct CSS layout changes were identified; modifications were concentrated in markup or scripts.';
    }

    if (intent.isPrioritization) {
      if (recommendations.length > 0) {
        return `I recommend prioritizing: 1) ${recommendations[0].title}. ${recommendations.length > 1 ? `2) ${recommendations[1].title}.` : ''} These adjustments deliver the highest visual clarity with minimal architectural risk.`;
      }
      return 'Start by standardizing container padding and flex gaps, followed by establishing a consistent typographic scale.';
    }

    if (recommendations.length > 0) {
      return `Based on an inspection of ${context.targetFiles.length} frontend files and ${context.cssDeclarations.length} CSS declarations, the key area for improvement is: ${recommendations[0].title}.`;
    }

    return 'The frontend structure follows solid baseline principles. For a more polished look, review container gutters, ensure consistent theme token usage, and verify heading hierarchy.';
  }

  private buildSummary(
    intent: QueryIntent,
    findings: DesignAnalysisFinding[],
    recommendations: DesignRecommendation[],
    context: DesignQueryContext
  ): string {
    const fileCount = context.targetFiles.length;
    const declCount = context.cssDeclarations.length;
    const issues = findings.filter((f) => f.type === 'issue').length;

    let base = `Analyzed ${fileCount} frontend file${fileCount === 1 ? '' : 's'} (${declCount} CSS rule${declCount === 1 ? '' : 's'}). `;
    base += `Identified ${findings.length} observation${findings.length === 1 ? '' : 's'} and ${recommendations.length} actionable recommendation${recommendations.length === 1 ? '' : 's'}. `;
    if (issues > 0) {
      base += `Found ${issues} potential visual or structural issue${issues === 1 ? '' : 's'}.`;
    } else {
      base += `No critical layout defects detected.`;
    }
    return base;
  }
}
