type EntryBody = string | Uint8Array;

type BinaryDocumentFixture = {
	name: string;
	path: string;
	mediaType: string;
	bytes: Uint8Array;
	expected: string;
};

const encoder = new TextEncoder();
const wordFixture = docx("DOCX fixture body");

export const documentFixtures: BinaryDocumentFixture[] = [
	{
		name: "PDF",
		path: "fixture.pdf",
		mediaType: "application/pdf",
		bytes: textPdf(
			"PDF fixture body with enough native text to classify the page as text based. ".repeat(
				24,
			),
		),
		expected: "PDF fixture body",
	},
	{
		name: "Word",
		path: "fixture.docx",
		mediaType:
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		bytes: wordFixture,
		expected: "DOCX fixture body",
	},
	{
		name: "PowerPoint",
		path: "fixture.pptx",
		mediaType:
			"application/vnd.openxmlformats-officedocument.presentationml.presentation",
		bytes: pptx("PPTX fixture body"),
		expected: "PPTX fixture body",
	},
	{
		name: "Excel",
		path: "fixture.xlsx",
		mediaType:
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		bytes: xlsx("XLSX fixture body"),
		expected: "XLSX fixture body",
	},
	{
		name: "CSV",
		path: "fixture.csv",
		mediaType: "text/csv",
		bytes: encoder.encode("name,value\nCSV fixture body,7\n"),
		expected: "CSV fixture body",
	},
	{
		name: "OpenDocument text",
		path: "fixture.odt",
		mediaType: "application/vnd.oasis.opendocument.text",
		bytes: odf(
			"application/vnd.oasis.opendocument.text",
			`<office:body><office:text><text:p>ODT fixture body</text:p></office:text></office:body>`,
		),
		expected: "ODT fixture body",
	},
	{
		name: "OpenDocument spreadsheet",
		path: "fixture.ods",
		mediaType: "application/vnd.oasis.opendocument.spreadsheet",
		bytes: odf(
			"application/vnd.oasis.opendocument.spreadsheet",
			`<office:body><office:spreadsheet><table:table table:name="Sheet"><table:table-row><table:table-cell office:value-type="string"><text:p>ODS fixture body</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body>`,
		),
		expected: "ODS fixture body",
	},
	{
		name: "EPUB",
		path: "fixture.epub",
		mediaType: "application/epub+zip",
		bytes: epub("EPUB fixture body"),
		expected: "EPUB fixture body",
	},
	{
		name: "RTF",
		path: "fixture.rtf",
		mediaType: "application/rtf",
		bytes: encoder.encode(
			"{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}\\f0\\fs24 RTF fixture body\\par}",
		),
		expected: "RTF fixture body",
	},
];

export const scannedPdf = imagePdf();
export const malformedDocx = wordFixture.subarray(0, 320);
export const encryptedOdt = zip({
	mimetype: "application/vnd.oasis.opendocument.text",
	"content.xml": new Uint8Array([0, 1, ...encoder.encode("ciphertext")]),
	"META-INF/manifest.xml": `<?xml version="1.0"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0">
<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml">
<manifest:encryption-data manifest:checksum-type="SHA1/1K" manifest:checksum="AAAA">
<manifest:algorithm manifest:algorithm-name="Blowfish CFB" manifest:initialisation-vector="BBBB"/>
<manifest:key-derivation manifest:key-derivation-name="PBKDF2" manifest:iteration-count="1024" manifest:salt="CCCC"/>
</manifest:encryption-data></manifest:file-entry></manifest:manifest>`,
});
export const resourceLimitDocx = docx(
	`${"<w:sdt><w:sdtContent>".repeat(260)}deep${"</w:sdtContent></w:sdt>".repeat(260)}`,
	true,
);

function docx(body: string, raw = false) {
	return zip({
		"[Content_Types].xml": contentTypes(
			"/word/document.xml",
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
		),
		"_rels/.rels": rootRelationship("word/document.xml"),
		"word/document.xml": `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${
			raw ? body : `<w:p><w:r><w:t>${body}</w:t></w:r></w:p>`
		}</w:body></w:document>`,
	});
}

function pptx(body: string) {
	return zip({
		"[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>`,
		"_rels/.rels": rootRelationship("ppt/presentation.xml"),
		"ppt/presentation.xml": `<?xml version="1.0" encoding="UTF-8"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`,
		"ppt/_rels/presentation.xml.rels": relationships(
			"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide",
			"slides/slide1.xml",
		),
		"ppt/slides/slide1.xml": `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>${body}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
	});
}

function xlsx(body: string) {
	return zip({
		"[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`,
		"_rels/.rels": rootRelationship("xl/workbook.xml"),
		"xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet" sheetId="1" r:id="rId1"/></sheets></workbook>`,
		"xl/_rels/workbook.xml.rels": relationships(
			"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet",
			"worksheets/sheet1.xml",
		),
		"xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${body}</t></is></c><c r="B1"><v>7</v></c></row></sheetData></worksheet>`,
	});
}

function odf(mimetype: string, body: string) {
	return zip({
		mimetype,
		"content.xml": `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">${body}</office:document-content>`,
	});
}

function epub(body: string) {
	return zip({
		mimetype: "application/epub+zip",
		"META-INF/container.xml": `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
		"OEBPS/content.opf": `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">fixture</dc:identifier><dc:title>Fixture</dc:title><dc:language>en</dc:language></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>`,
		"OEBPS/chapter.xhtml": `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Fixture</title></head><body><h1>${body}</h1></body></html>`,
	});
}

function contentTypes(part: string, mediaType: string) {
	return `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="${part}" ContentType="${mediaType}"/></Types>`;
}

function rootRelationship(target: string) {
	return relationships(
		"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
		target,
	);
}

function relationships(type: string, target: string) {
	return `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${type}" Target="${target}"/></Relationships>`;
}

function textPdf(text: string) {
	const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
	return pdf([
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
		`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	]);
}

function imagePdf() {
	const draw = "q 200 0 0 200 72 500 cm /Im1 Do Q";
	return pdf([
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>",
		`<< /Length ${Buffer.byteLength(draw)} >>\nstream\n${draw}\nendstream`,
		Buffer.concat([
			Buffer.from(
				"<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n",
			),
			Buffer.from([128]),
			Buffer.from("\nendstream"),
		]),
	]);
}

function pdf(objects: EntryBody[]) {
	const parts: Buffer[] = [
		Buffer.from("%PDF-1.4\n%\x80\x81\x82\x83\n", "binary"),
	];
	const offsets: number[] = [];
	let length = parts[0]!.byteLength;
	for (const [index, body] of objects.entries()) {
		offsets.push(length);
		const object = Buffer.concat([
			Buffer.from(`${index + 1} 0 obj\n`),
			bytes(body),
			Buffer.from("\nendobj\n"),
		]);
		parts.push(object);
		length += object.byteLength;
	}
	const xref = Buffer.from(
		`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
			.map((offset) => `${offset.toString().padStart(10, "0")} 00000 n `)
			.join(
				"\n",
			)}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`,
	);
	return Buffer.concat([...parts, xref]);
}

function zip(entries: Record<string, EntryBody>) {
	const local: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const [name, value] of Object.entries(entries)) {
		const nameBytes = Buffer.from(name);
		const data = bytes(value);
		const crc = Number(Bun.hash.crc32(data)) >>> 0;
		const header = Buffer.alloc(30);
		header.writeUInt32LE(0x04034b50, 0);
		header.writeUInt16LE(20, 4);
		header.writeUInt32LE(crc, 14);
		header.writeUInt32LE(data.byteLength, 18);
		header.writeUInt32LE(data.byteLength, 22);
		header.writeUInt16LE(nameBytes.byteLength, 26);
		local.push(header, nameBytes, data);

		const directory = Buffer.alloc(46);
		directory.writeUInt32LE(0x02014b50, 0);
		directory.writeUInt16LE(20, 4);
		directory.writeUInt16LE(20, 6);
		directory.writeUInt32LE(crc, 16);
		directory.writeUInt32LE(data.byteLength, 20);
		directory.writeUInt32LE(data.byteLength, 24);
		directory.writeUInt16LE(nameBytes.byteLength, 28);
		directory.writeUInt32LE(offset, 42);
		central.push(directory, nameBytes);
		offset += header.byteLength + nameBytes.byteLength + data.byteLength;
	}
	const centralBytes = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(Object.keys(entries).length, 8);
	end.writeUInt16LE(Object.keys(entries).length, 10);
	end.writeUInt32LE(centralBytes.byteLength, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...local, centralBytes, end]);
}

function bytes(value: EntryBody) {
	return typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
}
