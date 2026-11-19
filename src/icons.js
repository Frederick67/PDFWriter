// Icone Lucide (tratto uniforme, leggibili anche a piccole dimensioni). Solo quelle usate finiscono nel bundle.
import {
  FolderOpen, Plus, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, MoveHorizontal, Maximize, Save, Minus, Square, X, Copy,
  Files, ListTree, Search, MessageSquareText, Settings2, FilePlus, FileInput, Moon, Leaf, Grid3x3, MousePointer2, Lock,
  LockOpen, Undo2, Trash, Pen, PenTool, Pencil, Highlighter, Eraser, Crosshair, Type, Bookmark, Underline, Strikethrough,
  Circle, Slash, RotateCw, FileText, Upload, Keyboard, Brush, ALargeSmall, Info, CircleAlert, CircleCheck, TriangleAlert,
  RectangleHorizontal, Contrast, Redo2, Lasso, Ruler, BookOpen, EllipsisVertical, Printer, Image, FileOutput, Layers,
  ArrowUpRight, BookmarkPlus, PencilLine, Clock, Eye,
} from 'lucide';

const ICONS = {
  open: FolderOpen, plus: Plus, prev: ChevronLeft, next: ChevronRight, zoomIn: ZoomIn, zoomOut: ZoomOut, fitWidth: MoveHorizontal,
  fitPage: Maximize, save: Save, minimize: Minus, maximize: Square, restore: Copy, close: X, pages: Files, outline: ListTree,
  search: Search, markups: MessageSquareText, settings: Settings2, addBlank: FilePlus, addPdf: FileInput, moon: Moon, leaf: Leaf,
  grid: Grid3x3, pointer: MousePointer2, lock: Lock, unlock: LockOpen, undo: Undo2, copy: Copy, trash: Trash, pen: Pen,
  nib: PenTool, pencil: Pencil, highlighter: Highlighter, marker: Brush, eraser: Eraser, laser: Crosshair, text: Type,
  rect: RectangleHorizontal, bookmark: Bookmark, underline: Underline, strike: Strikethrough, circle: Circle, line: Slash,
  rotate: RotateCw, file: FileText, upload: Upload, keyboard: Keyboard, textSize: ALargeSmall, info: Info, error: CircleAlert,
  ok: CircleCheck, warn: TriangleAlert, contrast: Contrast, redo: Redo2, lasso: Lasso, ruler: Ruler, spread: BookOpen,
  more: EllipsisVertical, print: Printer, image: Image, extract: FileOutput, flatten: Layers, ellipse: Circle, arrow: ArrowUpRight,
  bookmarkAdd: BookmarkPlus, rename: PencilLine, recent: Clock, saveAs: Save, eye: Eye,
};

const attrs = (o) => Object.entries(o).map(([k, v]) => `${k}="${String(v).replace(/"/g, '&quot;')}"`).join(' ');
const node = ([tag, a, kids]) => `<${tag} ${attrs(a)}>${(kids || []).map(node).join('')}</${tag}>`;

// SVG come stringa (per innerHTML); il colore segue `currentColor`.
export function ic(name, { color, cls = '' } = {}) {
  const n = ICONS[name] || ICONS.pen;
  const style = color ? ` style="color:${color}"` : '';
  return `<svg class="ic ${cls}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"${style}>${n.map(node).join('')}</svg>`;
}

// Sostituisce gli <i data-icon="nome"> dell'HTML statico.
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('i[data-icon]')) el.outerHTML = ic(el.dataset.icon, { cls: el.className });
}
