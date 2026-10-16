// Shared source-element model for framework language support.
// A SourceElement is a static view of one markup element inside a framework
// source file (JSX/TSX, Vue/Astro/Svelte template), with exact byte ranges.
export interface SourceElement {
  file: string;
  start: number;
  end: number;
  tag: string; // lowercase host tag, or the component name for component usage
  component: boolean; // true for <Card /> style usages
  id?: string;
  testId?: string;
  classes: string[];
  href?: string;
  name?: string; // aria-label when statically present
  text: string; // normalized direct static text, capped
  ancestors: string[]; // element ancestor tags, outermost first
  parent: number; // index of the parent element in the same file's array, -1 if none
  dynamic: boolean; // contains expression children or spread attributes
}
export interface SourceIndex {
  file: string;
  elements: SourceElement[];
  stylesheets: string[]; // imported or linked style files, relative posix paths
  styleBlocks: { start: number; end: number; contentStart: number; contentEnd: number }[];
  cssInJs: boolean;
}
export interface PickInfo {
  tag?: string;
  id?: string;
  testId?: string;
  name?: string;
  href?: string;
  text?: string;
}
export const FRAMEWORK_EXTENSIONS = ['.jsx', '.tsx', '.vue', '.svelte', '.astro'];
export const SCRIPT_EXTENSIONS = ['.js', '.ts', ...FRAMEWORK_EXTENSIONS];
