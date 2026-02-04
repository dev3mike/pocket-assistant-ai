/**
 * Analyzes the page structure (navigation, forms, buttons, links) from the
 * accessibility tree. Used by the BROWSER SUB-AGENT and TaskPlannerService to
 * understand the current page when deciding clicks or typing targets. Helper
 * only; not part of the main message flow.
 */
import { Injectable, Logger } from '@nestjs/common';
import { AccessibilityNode } from './browser-tools.service';

export interface InteractiveElement {
  ref: string;
  type: 'button' | 'link' | 'input' | 'select' | 'checkbox' | 'radio' | 'other';
  name: string;
  value?: string;
  disabled?: boolean;
}

export interface FormField {
  ref: string;
  label: string;
  type: 'text' | 'password' | 'email' | 'search' | 'number' | 'checkbox' | 'radio' | 'select' | 'textarea' | 'other';
  value?: string;
  required?: boolean;
  disabled?: boolean;
}

export interface PageStructure {
  title: string;
  url: string;
  mainContent: string;
  navigation: InteractiveElement[];
  forms: FormField[];
  buttons: InteractiveElement[];
  links: InteractiveElement[];
  headings: { level: number; text: string }[];
  interactiveElements: InteractiveElement[];
}

export interface PageAnalysis {
  summary: string;
  structure: PageStructure;
  suggestedActions: string[];
}

@Injectable()
export class PageAnalyzerService {
  private readonly logger = new Logger(PageAnalyzerService.name);

  /**
   * Analyze accessibility tree and extract structured information
   */
  analyzeAccessibilityTree(
    nodes: AccessibilityNode[],
    url: string,
    title: string,
  ): PageAnalysis {
    const structure: PageStructure = {
      title,
      url,
      mainContent: '',
      navigation: [],
      forms: [],
      buttons: [],
      links: [],
      headings: [],
      interactiveElements: [],
    };

    // Flatten and categorize nodes
    this.processNodes(nodes, structure);

    // Generate summary
    const summary = this.generateSummary(structure);

    // Suggest possible actions
    const suggestedActions = this.suggestActions(structure);

    return {
      summary,
      structure,
      suggestedActions,
    };
  }

  /**
   * Process nodes recursively and categorize them
   */
  private processNodes(nodes: AccessibilityNode[], structure: PageStructure): void {
    for (const node of nodes) {
      this.categorizeNode(node, structure);

      if (node.children) {
        this.processNodes(node.children, structure);
      }
    }
  }

  /**
   * Categorize a single node
   */
  private categorizeNode(node: AccessibilityNode, structure: PageStructure): void {
    const { role, name, ref, value, disabled, level } = node;

    // Headings
    if (role === 'heading' && name) {
      structure.headings.push({
        level: level || 1,
        text: name,
      });
      return;
    }

    // Buttons
    if (role === 'button' && name) {
      const element: InteractiveElement = {
        ref,
        type: 'button',
        name,
        disabled,
      };
      structure.buttons.push(element);
      structure.interactiveElements.push(element);
      return;
    }

    // Links
    if (role === 'link' && name) {
      const element: InteractiveElement = {
        ref,
        type: 'link',
        name,
        disabled,
      };
      structure.links.push(element);
      structure.interactiveElements.push(element);
      return;
    }

    // Text inputs
    if (role === 'textbox' || role === 'searchbox' || role === 'combobox') {
      const fieldType = this.inferInputType(role, name);
      const field: FormField = {
        ref,
        label: name || 'Unnamed field',
        type: fieldType,
        value,
        disabled,
      };
      structure.forms.push(field);

      const element: InteractiveElement = {
        ref,
        type: 'input',
        name: name || 'Unnamed field',
        value,
        disabled,
      };
      structure.interactiveElements.push(element);
      return;
    }

    // Checkboxes and radios
    if (role === 'checkbox' || role === 'radio') {
      const field: FormField = {
        ref,
        label: name || 'Unnamed option',
        type: role as 'checkbox' | 'radio',
        value: node.checked?.toString(),
        disabled,
      };
      structure.forms.push(field);

      const element: InteractiveElement = {
        ref,
        type: role as 'checkbox' | 'radio',
        name: name || 'Unnamed option',
        disabled,
      };
      structure.interactiveElements.push(element);
      return;
    }

    // Select/dropdown
    if (role === 'listbox' || role === 'menuitem' || role === 'option') {
      if (name) {
        const element: InteractiveElement = {
          ref,
          type: 'select',
          name,
          value,
          disabled,
        };
        structure.interactiveElements.push(element);
      }
      return;
    }

    // Navigation landmarks
    if (role === 'navigation' && name) {
      structure.navigation.push({
        ref,
        type: 'other',
        name,
      });
      return;
    }
  }

  /**
   * Infer input type from role and name
   */
  private inferInputType(role: string, name?: string): FormField['type'] {
    const nameLower = (name || '').toLowerCase();

    if (role === 'searchbox' || nameLower.includes('search')) return 'search';
    if (nameLower.includes('password')) return 'password';
    if (nameLower.includes('email') || nameLower.includes('e-mail')) return 'email';
    if (nameLower.includes('phone') || nameLower.includes('number')) return 'number';

    return 'text';
  }

  /**
   * Generate a human-readable summary of the page
   */
  private generateSummary(structure: PageStructure): string {
    const parts: string[] = [];

    parts.push(`Page: "${structure.title}"`);
    parts.push(`URL: ${structure.url}`);

    if (structure.headings.length > 0) {
      const mainHeading = structure.headings.find(h => h.level === 1) || structure.headings[0];
      if (mainHeading) {
        parts.push(`Main heading: "${mainHeading.text}"`);
      }
    }

    if (structure.forms.length > 0) {
      parts.push(`Form fields: ${structure.forms.length} (${structure.forms.slice(0, 3).map(f => f.label).join(', ')}${structure.forms.length > 3 ? '...' : ''})`);
    }

    if (structure.buttons.length > 0) {
      parts.push(`Buttons: ${structure.buttons.length} (${structure.buttons.slice(0, 3).map(b => b.name).join(', ')}${structure.buttons.length > 3 ? '...' : ''})`);
    }

    if (structure.links.length > 0) {
      parts.push(`Links: ${structure.links.length}`);
    }

    return parts.join('\n');
  }

  /**
   * Suggest possible actions based on page structure
   */
  private suggestActions(structure: PageStructure): string[] {
    const actions: string[] = [];

    // Search functionality
    const searchField = structure.forms.find(f => f.type === 'search' || f.label.toLowerCase().includes('search'));
    if (searchField) {
      actions.push(`Search: Type in the search field [ref=${searchField.ref}]`);
    }

    // Login forms
    const hasEmail = structure.forms.some(f => f.type === 'email' || f.label.toLowerCase().includes('email'));
    const hasPassword = structure.forms.some(f => f.type === 'password' || f.label.toLowerCase().includes('password'));
    if (hasEmail && hasPassword) {
      actions.push('Login: This appears to be a login form. Fill email and password fields.');
    }

    // Submit buttons
    const submitButton = structure.buttons.find(b => 
      ['submit', 'sign in', 'log in', 'search', 'go', 'continue', 'next'].some(
        keyword => b.name.toLowerCase().includes(keyword)
      )
    );
    if (submitButton) {
      actions.push(`Submit: Click "${submitButton.name}" button [ref=${submitButton.ref}]`);
    }

    // Navigation
    if (structure.links.length > 0) {
      actions.push(`Navigate: ${structure.links.length} links available for navigation`);
    }

    return actions;
  }

  /**
   * Find elements matching a description
   */
  findElementsByDescription(
    nodes: AccessibilityNode[],
    description: string,
  ): { ref: string; name: string; role: string; score: number }[] {
    const results: { ref: string; name: string; role: string; score: number }[] = [];
    const descLower = description.toLowerCase();

    const searchNodes = (nodeList: AccessibilityNode[]): void => {
      for (const node of nodeList) {
        if (node.name) {
          const nameLower = node.name.toLowerCase();
          let score = 0;

          // Exact match
          if (nameLower === descLower) {
            score = 100;
          }
          // Contains match
          else if (nameLower.includes(descLower) || descLower.includes(nameLower)) {
            score = 50;
          }
          // Word match
          else {
            const descWords = descLower.split(/\s+/);
            const nameWords = nameLower.split(/\s+/);
            const matchingWords = descWords.filter(w => nameWords.some(nw => nw.includes(w) || w.includes(nw)));
            if (matchingWords.length > 0) {
              score = (matchingWords.length / descWords.length) * 30;
            }
          }

          // Boost for interactive elements
          if (['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio'].includes(node.role)) {
            score += 10;
          }

          if (score > 0) {
            results.push({
              ref: node.ref,
              name: node.name,
              role: node.role,
              score,
            });
          }
        }

        if (node.children) {
          searchNodes(node.children);
        }
      }
    };

    searchNodes(nodes);

    // Sort by score descending
    return results.sort((a, b) => b.score - a.score);
  }

  /**
   * Format page analysis for LLM consumption
   */
  formatForLLM(analysis: PageAnalysis): string {
    const lines: string[] = [];

    lines.push('=== PAGE ANALYSIS ===');
    lines.push(analysis.summary);
    lines.push('');

    if (analysis.structure.headings.length > 0) {
      lines.push('--- Headings ---');
      for (const h of analysis.structure.headings.slice(0, 5)) {
        lines.push(`  H${h.level}: ${h.text}`);
      }
      lines.push('');
    }

    if (analysis.structure.forms.length > 0) {
      lines.push('--- Form Fields ---');
      for (const f of analysis.structure.forms) {
        let fieldStr = `  [ref=${f.ref}] ${f.label} (${f.type})`;
        if (f.value) fieldStr += ` value="${f.value}"`;
        if (f.disabled) fieldStr += ' (disabled)';
        lines.push(fieldStr);
      }
      lines.push('');
    }

    if (analysis.structure.buttons.length > 0) {
      lines.push('--- Buttons ---');
      for (const b of analysis.structure.buttons.slice(0, 10)) {
        let btnStr = `  [ref=${b.ref}] "${b.name}"`;
        if (b.disabled) btnStr += ' (disabled)';
        lines.push(btnStr);
      }
      lines.push('');
    }

    if (analysis.suggestedActions.length > 0) {
      lines.push('--- Suggested Actions ---');
      for (const action of analysis.suggestedActions) {
        lines.push(`  • ${action}`);
      }
    }

    return lines.join('\n');
  }
}
