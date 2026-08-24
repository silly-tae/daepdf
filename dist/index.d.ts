export type PageSize = "A3" | "A4" | "A5" | "Letter" | "Legal" | "Tabloid" | {
	width: number;
	height: number;
};
export interface PageConfig {
	size: PageSize;
	orientation?: "portrait" | "landscape" | undefined;
}
export interface PDFMetadata {
	title?: string;
	author?: string;
	subject?: string;
	keywords?: string[];
	creator?: string;
	language?: string;
}
export interface PDFSecurity {
	userPassword?: string;
	ownerPassword?: string;
	permissions?: {
		print?: boolean;
		copy?: boolean;
		modify?: boolean;
		annotate?: boolean;
		fillForms?: boolean;
	};
}
export interface BookmarkEntry {
	title: string;
	page: number;
	y?: number;
	level?: number;
}
export interface FontBridgeMap {
	[cssFontFamily: string]: {
		name: string;
		style: string;
		weight: number;
	};
}
export interface HTMLToPDFOptions {
	metadata?: PDFMetadata | undefined;
	security?: PDFSecurity | null | undefined;
	bookmarks?: BookmarkEntry[] | undefined;
	header?: ((page: number, totalPages: number) => string) | undefined;
	footer?: ((page: number, totalPages: number) => string) | undefined;
	taggedPdf?: boolean | undefined;
	pdfA?: boolean | undefined;
}
export declare function previewHTML(html: string, container: HTMLElement, config: PageConfig): void;
export declare function renderHTMLtoPDF(html: string, config: PageConfig, options?: HTMLToPDFOptions, fonts?: FontBridgeMap): Promise<Uint8Array>;
export type SecurityPreset = "read-only" | "printable" | "fillable" | "locked" | "open";
export type SecurityOption = SecurityPreset | PDFSecurity | null;
export interface RenderExtras {
	metadata?: PDFMetadata;
	bookmarks?: BookmarkEntry[];
	orientation?: "portrait" | "landscape" | undefined;
	header?: (page: number, totalPages: number) => string;
	footer?: (page: number, totalPages: number) => string;
	taggedPdf?: boolean | undefined;
	pdfA?: boolean | undefined;
}
export declare function escapeHtml(s: string): string;
declare const pdf: {
	warmup(): Promise<void>;
	render(html: string, size?: PageSize, security?: SecurityOption, extras?: RenderExtras): Promise<Uint8Array>;
	download(html: string, size: PageSize | undefined, filename: string, security?: SecurityOption, extras?: RenderExtras): Promise<void>;
	name: (s: string) => string;
};

export {
	pdf as default,
};

export {};
