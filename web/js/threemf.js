// Schreibt ein Bambu-Studio-3MF: ein Objekt mit einem Teil pro Filament,
// jedes Teil ist dem passenden Filament (Extruder-Nummer) zugeordnet.

const enc = new TextEncoder();

// ---------- ZIP ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
async function deflateRaw(data) {
  if (typeof CompressionStream === 'undefined') return null;
  const cs = new CompressionStream('deflate-raw');
  const stream = new Blob([data]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** files: [{name, data: Uint8Array|string}] -> Uint8Array (ZIP) */
export async function zip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const name = enc.encode(f.name);
    const crc = crc32(data);
    let comp = data.length > 256 ? await deflateRaw(data) : null;
    let method = 8;
    if (!comp || comp.length >= data.length) { comp = data; method = 0; }
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
    lh.setUint16(8, method, true); lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, comp.length, true); lh.setUint32(22, data.length, true);
    lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), name, comp);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, method, true); ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, comp.length, true); ch.setUint32(24, data.length, true);
    ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + comp.length;
  }
  const cdSize = central.reduce((s, a) => s + a.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const total = all.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of all) { out.set(a, o); o += a.length; }
  return out;
}

// ---------- XML ----------
const xmlEsc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const num = (v) => {
  const s = v.toFixed(4);
  return s.indexOf('.') >= 0 ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
};
const uuid = (a, b) => `${a.toString(16).padStart(8, '0')}-${b.toString(16).padStart(4, '0')}-4000-8000-${Math.floor(Math.random() * 2 ** 48).toString(16).padStart(12, '0')}`;

function meshXml(id, m) {
  // Große Strings in Stücken bauen
  const chunks = [`  <object id="${id}" p:UUID="${uuid(0x10000 + id, 0)}" type="model">\n   <mesh>\n    <vertices>\n`];
  const P = m.positions, I = m.indices;
  let buf = [];
  for (let i = 0; i < P.length; i += 3) {
    buf.push(`     <vertex x="${num(P[i])}" y="${num(P[i + 1])}" z="${num(P[i + 2])}"/>`);
    if (buf.length > 20000) { chunks.push(buf.join('\n') + '\n'); buf = []; }
  }
  if (buf.length) chunks.push(buf.join('\n') + '\n');
  chunks.push('    </vertices>\n    <triangles>\n');
  buf = [];
  for (let i = 0; i < I.length; i += 3) {
    buf.push(`     <triangle v1="${I[i]}" v2="${I[i + 1]}" v3="${I[i + 2]}"/>`);
    if (buf.length > 20000) { chunks.push(buf.join('\n') + '\n'); buf = []; }
  }
  if (buf.length) chunks.push(buf.join('\n') + '\n');
  chunks.push('    </triangles>\n   </mesh>\n  </object>\n');
  return chunks;
}

const NS = 'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p"';

/**
 * parts: [{name, extruder (1-basiert), positions, indices}]
 * opts: { name, center: [x,y], layerHeight, thumbnail (Uint8Array PNG), smallThumbnail }
 */
export async function build3mf(parts, opts) {
  const objId = parts.length + 1;
  const date = new Date().toISOString().slice(0, 10);
  const valid = parts.filter((p) => p.indices.length > 0);

  const objChunks = [`<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" ${NS}>\n <metadata name="BambuStudio:3mfVersion">1</metadata>\n <resources>\n`];
  valid.forEach((p, i) => objChunks.push(...meshXml(i + 1, p)));
  objChunks.push(' </resources>\n <build/>\n</model>\n');
  const objBlob = new Blob(objChunks);
  const objData = new Uint8Array(await objBlob.arrayBuffer());

  const [cx, cy] = opts.center;
  const main = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" ${NS}>
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <metadata name="Title">${xmlEsc(opts.name)}</metadata>
 <metadata name="Designer">ChromaStack</metadata>
 <metadata name="CreationDate">${date}</metadata>
 <metadata name="ModificationDate">${date}</metadata>
 <resources>
  <object id="${objId}" p:UUID="${uuid(objId, 1)}" type="model">
   <components>
${valid.map((p, i) => `    <component p:path="/3D/Objects/object_1.model" objectid="${i + 1}" p:UUID="${uuid(objId, 2 + i)}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>`).join('\n')}
   </components>
  </object>
 </resources>
 <build p:UUID="${uuid(0, 3)}">
  <item objectid="${objId}" p:UUID="${uuid(objId, 99)}" transform="1 0 0 0 1 0 0 0 1 ${num(cx)} ${num(cy)} 0" printable="1"/>
 </build>
</model>
`;

  const faces = valid.reduce((s, p) => s + p.indices.length / 3, 0);
  const settings = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="${objId}">
    <metadata key="name" value="${xmlEsc(opts.name)}"/>
    <metadata key="extruder" value="${valid[0].extruder}"/>
${opts.layerHeight ? `    <metadata key="layer_height" value="${opts.layerHeight}"/>\n` : ''}${(opts.objectSettings || []).map(([k, v]) => `    <metadata key="${k}" value="${xmlEsc(v)}"/>\n`).join('')}    <metadata face_count="${faces}"/>
${valid.map((p, i) => `    <part id="${i + 1}" subtype="normal_part">
      <metadata key="name" value="${xmlEsc(p.name)}"/>
      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>
      <metadata key="extruder" value="${p.extruder}"/>
      <mesh_stat face_count="${p.indices.length / 3}" edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>
    </part>`).join('\n')}
  </object>
  <plate>
    <metadata key="plater_id" value="1"/>
    <metadata key="plater_name" value=""/>
    <metadata key="locked" value="false"/>
${opts.thumbnail ? '    <metadata key="thumbnail_file" value="Metadata/plate_1.png"/>\n' : ''}    <model_instance>
      <metadata key="object_id" value="${objId}"/>
      <metadata key="instance_id" value="0"/>
      <metadata key="identify_id" value="100"/>
    </model_instance>
  </plate>
  <assemble>
   <assemble_item object_id="${objId}" instance_id="0" transform="1 0 0 0 1 0 0 0 1 ${num(cx)} ${num(cy)} 0" offset="0 0 0" />
  </assemble>
</config>
`;

  const files = [
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="png" ContentType="image/png"/>
 <Default Extension="gcode" ContentType="text/x.gcode"/>
</Types>
` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
${opts.thumbnail ? ` <Relationship Target="/Metadata/plate_1.png" Id="rel-2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail"/>
 <Relationship Target="/Metadata/plate_1.png" Id="rel-4" Type="http://schemas.bambulab.com/package/2021/cover-thumbnail-middle"/>
 <Relationship Target="/Metadata/plate_1_small.png" Id="rel-5" Type="http://schemas.bambulab.com/package/2021/cover-thumbnail-small"/>
` : ''}</Relationships>
` },
    { name: '3D/3dmodel.model', data: main },
    { name: '3D/_rels/3dmodel.model.rels', data: `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/Objects/object_1.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
` },
    { name: '3D/Objects/object_1.model', data: objData },
    { name: 'Metadata/model_settings.config', data: settings },
  ];
  if (opts.thumbnail) {
    files.push({ name: 'Metadata/plate_1.png', data: opts.thumbnail });
    files.push({ name: 'Metadata/plate_1_small.png', data: opts.smallThumbnail || opts.thumbnail });
  }
  return zip(files);
}
