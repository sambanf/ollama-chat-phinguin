// Minimal, safe Markdown renderer for chat output.
// All text is HTML-escaped first; only a fixed set of tags is ever produced.
(function () {
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
  const PH = ""; // private-use placeholder char

  function renderInline(text) {
    const codes = [];
    let s = text.replace(/`([^`\n]+)`/g, (_, c) => {
      codes.push(c);
      return `${PH}${codes.length - 1}${PH}`;
    });
    s = escapeHtml(s);
    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
      (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,:;!?'"])/g,
      (_, pre, u) => `${pre}<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
    s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, "$1<strong>$2</strong>");
    s = s.replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)/g, "$1<em>$2</em>");
    s = s.replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, "$1<em>$2</em>");
    s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
    s = s.replace(new RegExp(`${PH}(\\d+)${PH}`, "g"), (_, i) => `<code>${escapeHtml(codes[+i])}</code>`);
    return s;
  }

  function codeBlock(code, lang) {
    return `<div class="code-block"><div class="code-head"><span>${escapeHtml(lang || "text")}</span>` +
      `<button type="button" class="copy-code">Copy</button></div>` +
      `<pre><code>${escapeHtml(code)}</code></pre></div>`;
  }

  const FENCE = /^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*)[^`]*$/;
  const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
  const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/;

  const splitRow = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

  function buildList(items) {
    let html = "";
    const stack = [];
    for (const it of items) {
      const tag = it.ordered ? "ol" : "ul";
      while (stack.length && it.indent < stack[stack.length - 1].indent) {
        html += `</li></${stack.pop().tag}>`;
      }
      const top = stack[stack.length - 1];
      if (!top || it.indent > top.indent) {
        const start = it.ordered && it.start > 1 ? ` start="${it.start}"` : "";
        html += `<${tag}${start}>`;
        stack.push({ indent: it.indent, tag });
      } else {
        html += "</li>";
        if (top.tag !== tag) {
          html += `</${top.tag}><${tag}>`;
          top.tag = tag;
        }
      }
      html += `<li>${it.text.split("\n").map(renderInline).join("<br>")}`;
    }
    while (stack.length) html += `</li></${stack.pop().tag}>`;
    return html;
  }

  function render(src) {
    const lines = String(src).replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let para = [];
    const flush = () => {
      if (para.length) out.push(`<p>${para.map(renderInline).join("<br>")}</p>`);
      para = [];
    };

    for (let i = 0; i < lines.length; ) {
      const line = lines[i];

      const fence = line.match(FENCE);
      if (fence) {
        flush();
        const indent = fence[1].length;
        const marker = fence[2];
        const buf = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(marker)) {
          buf.push(lines[i].slice(Math.min(indent, lines[i].search(/\S|$/))));
          i++;
        }
        i++; // closing fence (or end of a still-streaming block)
        out.push(codeBlock(buf.join("\n"), fence[3]));
        continue;
      }

      if (!line.trim()) { flush(); i++; continue; }

      const h = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
      if (h) {
        flush();
        out.push(`<h${h[1].length}>${renderInline(h[2])}</h${h[1].length}>`);
        i++;
        continue;
      }

      if (HR.test(line)) { flush(); out.push("<hr>"); i++; continue; }

      if (/^\s*>/.test(line)) {
        flush();
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
        out.push(`<blockquote>${render(buf.join("\n"))}</blockquote>`);
        continue;
      }

      if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
        flush();
        const head = splitRow(line);
        const aligns = splitRow(lines[i + 1]).map((c) =>
          c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "");
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(splitRow(lines[i++]));
        const cell = (tag, c, j) =>
          `<${tag}${aligns[j] ? ` class="align-${aligns[j]}"` : ""}>${renderInline(c ?? "")}</${tag}>`;
        out.push(
          `<div class="table-wrap"><table><thead><tr>${head.map((c, j) => cell("th", c, j)).join("")}</tr></thead>` +
          `<tbody>${rows.map((r) => `<tr>${head.map((_, j) => cell("td", r[j], j)).join("")}</tr>`).join("")}</tbody></table></div>`
        );
        continue;
      }

      if (LIST_ITEM.test(line)) {
        flush();
        const items = [];
        while (i < lines.length) {
          const l = lines[i];
          if (FENCE.test(l)) break;
          const m = l.match(LIST_ITEM);
          if (m && !HR.test(l)) {
            items.push({
              indent: m[1].replace(/\t/g, "    ").length,
              ordered: /\d/.test(m[2]),
              start: parseInt(m[2], 10),
              text: m[3],
            });
            i++;
            continue;
          }
          if (items.length && /^\s+\S/.test(l)) { items[items.length - 1].text += "\n" + l.trim(); i++; continue; }
          if (!l.trim() && i + 1 < lines.length && LIST_ITEM.test(lines[i + 1])) { i++; continue; }
          break;
        }
        out.push(buildList(items));
        continue;
      }

      para.push(line.trim());
      i++;
    }
    flush();
    return out.join("");
  }

  window.Markdown = { render, escapeHtml };
})();
