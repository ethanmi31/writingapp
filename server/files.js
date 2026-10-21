// File parsing: documents (txt/md/docx/pdf/html), SillyTavern lorebooks and character cards (JSON or PNG).

export async function extractText(file) {
  const name = (file.originalname || '').toLowerCase();
  if (name.endsWith('.docx')) {
    const mammoth = (await import('mammoth')).default;
    return (await mammoth.extractRawText({ buffer: file.buffer })).value;
  }
  if (name.endsWith('.pdf')) {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: file.buffer });
    try {
      return (await parser.getText()).text;
    } finally {
      await parser.destroy?.();
    }
  }
  const text = file.buffer.toString('utf8');
  if (name.endsWith('.html') || name.endsWith('.htm')) return htmlToText(text);
  return text;
}

function htmlToText(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n\n')
    .replace(/<h([1-6])[^>]*>/gi, (_, n) => '#'.repeat(Number(n)) + ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Character card PNGs carry their JSON base64-encoded in a tEXt chunk ("chara" for V2, "ccv3" for V3). */
export function readPngCard(buffer) {
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) return null;
  let off = 8;
  let found = null;
  while (off + 8 < buffer.length) {
    const len = buffer.readUInt32BE(off);
    const type = buffer.toString('latin1', off + 4, off + 8);
    if (type === 'tEXt') {
      const data = buffer.subarray(off + 8, off + 8 + len);
      const sep = data.indexOf(0);
      const keyword = data.toString('latin1', 0, sep);
      if (keyword === 'ccv3' || keyword === 'chara') {
        try {
          const json = JSON.parse(Buffer.from(data.toString('latin1', sep + 1), 'base64').toString('utf8'));
          if (keyword === 'ccv3' || !found) found = json; // V3 wins when both are present
        } catch {}
      }
    }
    if (type === 'IEND') break;
    off += 12 + len;
  }
  return found;
}

// --- PNG writing, so exported character cards open in SillyTavern -------------------------------------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Returns a copy of the PNG with the card embedded (replacing any existing card chunks). */
export function writePngCard(png, card) {
  const chunks = [];
  let off = 8;
  while (off + 8 <= png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('latin1', off + 4, off + 8);
    const whole = png.subarray(off, off + 12 + len);
    const data = png.subarray(off + 8, off + 8 + len);
    const isCard = type === 'tEXt' && ['chara', 'ccv3'].includes(data.toString('latin1', 0, Math.max(0, data.indexOf(0))));
    if (!isCard) chunks.push({ type, whole });
    off += 12 + len;
    if (type === 'IEND') break;
  }
  const text = (keyword, value) => {
    const data = Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(Buffer.from(JSON.stringify(value), 'utf8').toString('base64'), 'latin1')]);
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write('tEXt', 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const out = [png.subarray(0, 8)];
  for (const c of chunks) {
    if (c.type === 'IEND') out.push(text('chara', card), text('ccv3', { ...card, spec: 'chara_card_v3', spec_version: '3.0' }));
    out.push(c.whole);
  }
  return Buffer.concat(out);
}

/** Normalizes a V1/V2/V3 character card into our character shape (+ its embedded lorebook, if any). */
export function parseCharacterCard(json) {
  if (!json || typeof json !== 'object') return null;
  const d = json.data && typeof json.data === 'object' ? json.data : json;
  if (!d.name && !d.char_name) return null;
  const str = (v) => (v == null ? '' : String(v));
  return {
    character: {
      name: str(d.name || d.char_name).trim(),
      description: str(d.description || d.char_persona),
      personality: str(d.personality),
      scenario: str(d.scenario || d.world_scenario),
      first_message: str(d.first_mes || d.char_greeting),
      alt_greetings: Array.isArray(d.alternate_greetings) ? d.alternate_greetings.map(str).filter((g) => g.trim()) : [],
      example_dialogue: str(d.mes_example || d.example_dialogue),
      system_prompt: str(d.system_prompt),
      post_history: str(d.post_history_instructions),
      creator_notes: str(d.creator_notes || d.creatorcomment),
      tags: Array.isArray(d.tags) ? d.tags.map(str) : []
    },
    book: d.character_book || null
  };
}

/** Our character back to a V2 card (readable by SillyTavern and most other front-ends). */
export function toCharacterCard(c, bookEntries = null) {
  const data = {
    name: c.name,
    description: c.description,
    personality: c.personality,
    scenario: c.scenario,
    first_mes: c.first_message,
    mes_example: c.example_dialogue,
    creator_notes: c.creator_notes,
    system_prompt: c.system_prompt,
    post_history_instructions: c.post_history,
    alternate_greetings: JSON.parse(c.alt_greetings || '[]'),
    tags: JSON.parse(c.tags || '[]'),
    creator: '',
    character_version: '',
    extensions: {}
  };
  if (bookEntries?.length) data.character_book = { name: `${c.name}'s lore`, entries: bookEntries };
  return { spec: 'chara_card_v2', spec_version: '2.0', data };
}
