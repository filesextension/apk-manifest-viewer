/*!
 * axml-parser.js
 * Minimal, dependency-free parser for Android Binary XML (AXML), the format
 * used for the compiled AndroidManifest.xml inside every .apk file.
 * Decodes the chunked binary format (string pool + XML node chunks) into a
 * plain JS element tree so the browser can read package name, permissions,
 * and SDK versions directly from the manifest — no server involved.
 *
 * Part of the file-extension.com APK Opener tool. MIT-style: free to reuse.
 */
(function (global) {
  "use strict";

  // Chunk type constants (from the AXML / resources.arsc binary format).
  const CHUNK_STRING_POOL = 0x0001;
  const CHUNK_XML_RESOURCE_MAP = 0x0180;
  const CHUNK_XML_START_NAMESPACE = 0x0100;
  const CHUNK_XML_END_NAMESPACE = 0x0101;
  const CHUNK_XML_START_ELEMENT = 0x0102;
  const CHUNK_XML_END_ELEMENT = 0x0103;
  const CHUNK_XML_CDATA = 0x0104;

  const UTF8_FLAG = 0x00000100;

  function readStringPool(view, chunkStart) {
    // chunkStart points at the 2-byte type field of this chunk.
    const chunkSize = view.getUint32(chunkStart + 4, true);
    const stringCount = view.getUint32(chunkStart + 8, true);
    const styleCount = view.getUint32(chunkStart + 12, true);
    const flags = view.getUint32(chunkStart + 16, true);
    const stringsStart = view.getUint32(chunkStart + 20, true);
    const isUtf8 = (flags & UTF8_FLAG) !== 0;

    const offsetsStart = chunkStart + 28;
    const strings = new Array(stringCount);

    for (let i = 0; i < stringCount; i++) {
      const relOffset = view.getUint32(offsetsStart + i * 4, true);
      const strOffset = chunkStart + stringsStart + relOffset;
      strings[i] = isUtf8
        ? readUtf8String(view, strOffset)
        : readUtf16String(view, strOffset);
    }

    return { strings, end: chunkStart + chunkSize };
  }

  function readUtf16String(view, offset) {
    // Length is encoded in one or two UTF-16 code units.
    let len = view.getUint16(offset, true);
    let pos = offset + 2;
    if (len & 0x8000) {
      // Extended length: high bit set means a second unit holds the rest.
      const low = view.getUint16(pos, true);
      len = ((len & 0x7fff) << 16) | low;
      pos += 2;
    }
    let out = "";
    for (let i = 0; i < len; i++) {
      out += String.fromCharCode(view.getUint16(pos + i * 2, true));
    }
    return out;
  }

  function readUtf8String(view, offset) {
    // First length value = UTF-16 length (decoded char count), skip it.
    let pos = offset;
    let charLen = view.getUint8(pos);
    pos += 1;
    if (charLen & 0x80) {
      charLen = ((charLen & 0x7f) << 8) | view.getUint8(pos);
      pos += 1;
    }
    // Second length value = actual UTF-8 byte length.
    let byteLen = view.getUint8(pos);
    pos += 1;
    if (byteLen & 0x80) {
      byteLen = ((byteLen & 0x7f) << 8) | view.getUint8(pos);
      pos += 1;
    }
    const bytes = new Uint8Array(view.buffer, view.byteOffset + pos, byteLen);
    return new TextDecoder("utf-8").decode(bytes);
  }

  function resolveAttrValue(view, strings, rawValueIdx, valueOffset) {
    // Typed value struct: size(u16) res0(u8) dataType(u8) data(u32)
    const dataType = view.getUint8(valueOffset + 3);
    const data = view.getUint32(valueOffset + 4, true);

    if (rawValueIdx !== 0xffffffff && strings[rawValueIdx] !== undefined) {
      return strings[rawValueIdx];
    }
    switch (dataType) {
      case 0x12: // boolean
        return data !== 0;
      case 0x10: // int decimal
      case 0x11: // int hex
        return data;
      case 0x01: // reference to another resource
        return "@0x" + data.toString(16);
      case 0x03: // string (should have had rawValueIdx set, fallback)
        return strings[data] !== undefined ? strings[data] : "";
      default:
        return data;
    }
  }

  /**
   * Parses a binary AndroidManifest.xml ArrayBuffer into a simplified tree:
   * { name, attrs: {a:b,...}, children: [...] }
   */
  function parseAXML(arrayBuffer) {
    const view = new DataView(arrayBuffer);
    let strings = [];
    let pos = 0;
    const fileSize = view.getUint32(4, true);
    pos = 8; // skip file header (type u16, headerSize u16, size u32)

    const root = { name: "#root", attrs: {}, children: [] };
    const stack = [root];

    while (pos < fileSize && pos < arrayBuffer.byteLength - 8) {
      const type = view.getUint16(pos, true);
      const headerSize = view.getUint16(pos + 2, true);
      const chunkSize = view.getUint32(pos + 4, true);
      if (chunkSize <= 0) break;

      if (type === CHUNK_STRING_POOL) {
        const res = readStringPool(view, pos);
        strings = res.strings;
      } else if (type === CHUNK_XML_START_ELEMENT) {
        // Common node header (16 bytes: type,headerSize,size,lineNumber,comment)
        // is followed by the ResXMLTree_attrExt struct at pos+16:
        //   ns(u32) name(u32) attributeStart(u16) attributeSize(u16)
        //   attributeCount(u16) idIndex(u16) classIndex(u16) styleIndex(u16)
        // attributeStart is a byte offset *relative to the attrExt struct*
        // (pos+16), not to the outer chunk's headerSize — using headerSize
        // here would misalign onto the attrExt fields themselves.
        const attrExtStart = pos + 16;
        const nsIdx = view.getUint32(attrExtStart, true);
        const nameIdx = view.getUint32(attrExtStart + 4, true);
        const attributeStart = view.getUint16(attrExtStart + 8, true);
        const attrCount = view.getUint16(attrExtStart + 12, true);
        const elemName = strings[nameIdx] || ("ns" + nsIdx + ":?");

        const el = { name: elemName, attrs: {}, children: [] };
        let attrPos = attrExtStart + attributeStart;
        for (let i = 0; i < attrCount; i++) {
          const attrNameIdx = view.getUint32(attrPos + 4, true);
          const attrRawValueIdx = view.getUint32(attrPos + 8, true);
          const valueOffset = attrPos + 12; // typed value struct starts here
          const attrName = strings[attrNameIdx] || ("attr" + attrNameIdx);
          el.attrs[attrName] = resolveAttrValue(view, strings, attrRawValueIdx, valueOffset);
          attrPos += 20; // each attribute record is 20 bytes
        }

        stack[stack.length - 1].children.push(el);
        stack.push(el);
      } else if (type === CHUNK_XML_END_ELEMENT) {
        if (stack.length > 1) stack.pop();
      }
      // CHUNK_XML_RESOURCE_MAP, namespaces and CDATA are skipped —
      // not needed for the summary fields this tool extracts.

      pos += chunkSize;
    }

    return root.children[0] || root;
  }

  function findAll(node, tagName, out) {
    out = out || [];
    if (node.name === tagName) out.push(node);
    for (const child of node.children || []) findAll(child, tagName, out);
    return out;
  }

  function findFirst(node, tagName) {
    if (node.name === tagName) return node;
    for (const child of node.children || []) {
      const found = findFirst(child, tagName);
      if (found) return found;
    }
    return null;
  }

  /** High-level helper: pulls the common manifest fields a visitor cares about. */
  function summarizeManifest(arrayBuffer) {
    const tree = parseAXML(arrayBuffer);
    const manifest = tree.name === "manifest" ? tree : findFirst(tree, "manifest");
    const usesSdk = manifest ? findFirst(manifest, "uses-sdk") : null;
    const permissions = manifest
      ? findAll(manifest, "uses-permission")
          .concat(findAll(manifest, "uses-permission-sdk-23"))
          .map((n) => n.attrs.name)
          .filter(Boolean)
      : [];
    const application = manifest ? findFirst(manifest, "application") : null;

    return {
      package: manifest ? manifest.attrs.package : undefined,
      versionCode: manifest ? manifest.attrs.versionCode : undefined,
      versionName: manifest ? manifest.attrs.versionName : undefined,
      minSdkVersion: usesSdk ? usesSdk.attrs.minSdkVersion : undefined,
      targetSdkVersion: usesSdk ? usesSdk.attrs.targetSdkVersion : undefined,
      permissions: [...new Set(permissions)].sort(),
      appLabel: application ? application.attrs.label : undefined,
      tree,
    };
  }

  global.AXML = { parse: parseAXML, summarizeManifest, findAll, findFirst };
})(window);
