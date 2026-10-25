/* =========================================================
 * 笔记整理助手 —— 前端主逻辑
 * 功能：图片上传 → OCR 识别 → 整理笔记 → 保存 → 自我考核
 * 数据：保存在浏览器 localStorage，不上传服务器（AI 整理除外）
 * ========================================================= */

(() => {
  "use strict";

  // ---------- 常量 ----------
  const STORE_NOTES = "noteOrganizer.notes";
  const STORE_SETTINGS = "noteOrganizer.settings";
  const TYPE_LABELS = { word: "单词", qa: "问答", concept: "概念", general: "普通" };

  // ---------- 全局状态 ----------
  let notes = [];       // 笔记数组
  let settings = { baseUrl: "", model: "", key: "" };
  let ocrFiles = [];    // 待识别图片
  let quizState = null; // 考核状态
  let editingNoteId = null;

  // ---------- 工具函数 ----------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove("show"), 2200);
  }

  function saveNotes() {
    localStorage.setItem(STORE_NOTES, JSON.stringify(notes));
    $("#noteCount").textContent = notes.length;
  }

  function loadNotes() {
    try {
      notes = JSON.parse(localStorage.getItem(STORE_NOTES) || "[]");
      if (!Array.isArray(notes)) notes = [];
    } catch (e) { notes = []; }
  }

  function loadSettings() {
    try {
      settings = Object.assign(settings, JSON.parse(localStorage.getItem(STORE_SETTINGS) || "{}"));
    } catch (e) {}
  }

  function saveSettings() {
    localStorage.setItem(STORE_SETTINGS, JSON.stringify(settings));
  }

  function normalize(s) {
    return (s || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[，。！？、；：,.!?;:'"“”‘’()（）\[\]【】<>《》]/g, "")
      .trim();
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ---------- 视图切换 ----------
  function switchView(name) {
    $$(".view").forEach((v) => v.classList.remove("active"));
    $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === name));
    $("#view-" + name).classList.add("active");
  }

  // =========================================================
  // 第一部分：上传与 OCR
  // =========================================================
  const dropzone = $("#dropzone");
  const fileInput = $("#fileInput");

  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("drag"); });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag"));
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("drag");
    addFiles(e.dataTransfer.files);
  });
  fileInput.addEventListener("change", () => {
    addFiles(fileInput.files);
    fileInput.value = "";
  });

  function addFiles(list) {
    Array.from(list).forEach((f) => {
      if (f.type.startsWith("image/")) ocrFiles.push(f);
    });
    renderPreviews();
  }

  function renderPreviews() {
    const box = $("#previews");
    box.innerHTML = "";
    ocrFiles.forEach((f, i) => {
      const url = URL.createObjectURL(f);
      const wrap = document.createElement("div");
      wrap.style.position = "relative";
      const img = document.createElement("img");
      img.src = url;
      const del = document.createElement("button");
      del.className = "icon-btn del";
      del.style.cssText = "position:absolute;top:2px;right:2px;background:rgba(255,255,255,.85);border-radius:50%;";
      del.textContent = "✕";
      del.onclick = () => { ocrFiles.splice(i, 1); renderPreviews(); };
      wrap.append(img, del);
      box.appendChild(wrap);
    });
    $("#btnOcr").disabled = ocrFiles.length === 0;
  }

  function selectedLangs() {
    const l = $$("#langs input:checked").map((c) => c.value);
    return l.length ? l.join("+") : "eng";
  }

  async function runOcr() {
    if (!ocrFiles.length) return;
    const btn = $("#btnOcr");
    btn.disabled = true;
    const progress = $("#ocrProgress");
    const fill = $("#progressFill");
    const text = $("#progressText");
    progress.hidden = false;
    fill.style.width = "0%";
    text.textContent = "正在加载识别引擎…";

    let allText = "";
    try {
      // 合并多张图片到画布会失真，这里逐张识别后拼接
      let processed = 0;
      for (const file of ocrFiles) {
        const result = await Tesseract.recognize(file, selectedLangs(), {
          logger: (m) => {
            if (m.status === "recognizing text") {
              const p = Math.round(((processed + m.progress) / ocrFiles.length) * 100);
              fill.style.width = p + "%";
              text.textContent = `正在识别 第 ${processed + 1}/${ocrFiles.length} 张 · ${Math.round(m.progress * 100)}%`;
            }
          },
        });
        allText += result.data.text.trim() + "\n\n";
        processed++;
      }
      $("#rawText").value = allText.trim();
      $("#resultPanel").hidden = false;
      toast("识别完成，可编辑后整理成笔记");
    } catch (err) {
      console.error(err);
      toast("识别失败：" + (err.message || err));
    } finally {
      btn.disabled = false;
      progress.hidden = true;
    }
  }

  // =========================================================
  // 第二部分：整理笔记（规则解析 + AI 整理）
  // =========================================================
  const SEPARATORS = [" — ", " – ", " - ", "\t", "：", ":", "＝", "="];

  function looksLikeWord(s) {
    // 单词：不含空白，主要由字母组成，或 2~4 个汉字/短词
    if (!s) return false;
    if (/^\s*[A-Za-z][A-Za-z'-]*\s*$/.test(s)) return true;
    if (/^\s*[\u4e00-\u9fa5]{1,6}\s*$/.test(s)) return true;
    return false;
  }

  function splitFrontBack(line) {
    for (const sep of SEPARATORS) {
      const idx = line.indexOf(sep);
      if (idx > 0) {
        const front = line.slice(0, idx).trim();
        const back = line.slice(idx + sep.length).trim();
        if (front && back) return { front, back };
      }
    }
    // 两个及以上空格作为分隔
    const m = line.match(/^(.+?)\s{2,}(.+)$/);
    if (m && m[1].trim() && m[2].trim()) return { front: m[1].trim(), back: m[2].trim() };
    return null;
  }

  function parseTextToNotes(raw) {
    const result = [];
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      // Q&A 模式：Q:xxx 下一行 A:xxx
      if (/^(q|问|问题)[:：]\s*/i.test(line)) {
        const front = line.replace(/^(q|问|问题)[:：]\s*/i, "").trim();
        let back = "";
        if (i + 1 < lines.length && /^(a|答|答案)[:：]\s*/i.test(lines[i + 1])) {
          back = lines[i + 1].replace(/^(a|答|答案)[:：]\s*/i, "").trim();
          i++;
        }
        if (front && back) result.push({ front, back, type: "qa" });
        i++;
        continue;
      }

      const fb = splitFrontBack(line);
      if (fb) {
        // 简化的类型推断
        let t = "qa";
        if (looksLikeWord(fb.front)) t = "word";
        else if (fb.front.length <= 20 && fb.back.length > 10) t = "concept";
        result.push({ front: fb.front, back: fb.back, type: t });
        i++;
        continue;
      }

      // 无法解析的行，作为普通笔记（标题=第一行，内容=该行）
      result.push({ front: line.length > 30 ? line.slice(0, 30) + "…" : line, back: line, type: "general" });
      i++;
    }
    return result;
  }

  function addParsedNotes(parsed) {
    if (!parsed.length) { toast("没有识别到可整理的内容"); return; }
    parsed.forEach((p) => {
      notes.push({
        id: uid(),
        front: p.front,
        back: p.back,
        type: p.type || "general",
        tags: [],
        createdAt: Date.now(),
      });
    });
    saveNotes();
    renderNoteList();
    renderParsedPreview(parsed);
    toast(`已新增 ${parsed.length} 条笔记`);
  }

  function renderParsedPreview(parsed) {
    const box = $("#parsedPreview");
    box.innerHTML = "";
    parsed.forEach((p) => {
      const div = document.createElement("div");
      div.className = "note-card";
      div.innerHTML = `<div class="front">${escapeHtml(p.front)}</div>
        <div class="back">${escapeHtml(p.back)}</div>
        <span class="type-pill">${TYPE_LABELS[p.type] || "普通"}</span>`;
      box.appendChild(div);
    });
  }

  function parseFromRaw() {
    const raw = $("#rawText").value.trim();
    if (!raw) { toast("请先识别或输入文字"); return; }
    addParsedNotes(parseTextToNotes(raw));
  }

  // ---------- AI 智能整理 ----------
  async function aiParse() {
    const raw = $("#rawText").value.trim();
    if (!raw) { toast("请先识别或输入文字"); return; }
    if (!settings.key || !settings.baseUrl) {
      toast("请先在「设置」里配置 AI 接口地址与 Key");
      switchView("settings");
      return;
    }
    const btn = $("#btnAiParse");
    btn.disabled = true;
    btn.textContent = "整理中…";
    try {
      const notes = await callAi(raw);
      addParsedNotes(notes);
    } catch (err) {
      console.error(err);
      toast("AI 整理失败：" + (err.message || err));
    } finally {
      btn.disabled = false;
      btn.textContent = "✨ AI 智能整理";
    }
  }

  async function callAi(raw) {
    const url = settings.baseUrl.replace(/\/+$/, "") + "/chat/completions";
    const sys = "你是学习笔记整理助手。请把用户提供的文字整理成一条条用于复习的笔记（类似闪卡）。" +
      "只输出 JSON 数组，不要任何多余文字。每一项字段为：front（正面：单词/问题/概念名）、back（背面：释义/答案/说明）、type（word/qa/concept/general 之一）。" +
      "例如：[{\"front\":\"apple\",\"back\":\"n. 苹果\",\"type\":\"word\"}]";
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + settings.key,
      },
      body: JSON.stringify({
        model: settings.model || "gpt-3.5-turbo",
        messages: [
          { role: "system", content: sys },
          { role: "user", content: raw },
        ],
        temperature: 0.3,
      }),
    });
    if (!resp.ok) {
      const t = await resp.text();
      throw new Error("HTTP " + resp.status + " " + t.slice(0, 200));
    }
    const data = await resp.json();
    const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) throw new Error("接口未返回内容");
    // 提取 JSON（兼容被 markdown 包裹的情况）
    const jsonText = content.replace(/```json|```/g, "").trim();
    let arr;
    try {
      arr = JSON.parse(jsonText);
    } catch (e) {
      const m = jsonText.match(/\[[\s\S]*\]/);
      if (!m) throw new Error("无法解析 AI 返回的 JSON");
      arr = JSON.parse(m[0]);
    }
    return arr.filter((x) => x && (x.front || x.back)).map((x) => ({
      front: String(x.front || "").trim(),
      back: String(x.back || "").trim(),
      type: ["word", "qa", "concept", "general"].includes(x.type) ? x.type : "general",
    })).filter((x) => x.front && x.back);
  }

  // =========================================================
  // 第三部分：笔记管理
  // =========================================================
  function escapeHtml(s) {
    return (s || "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function renderNoteList() {
    const q = $("#searchInput").value.trim().toLowerCase();
    const type = $("#typeFilter").value;
    const box = $("#noteList");
    box.innerHTML = "";
    const filtered = notes.filter((n) => {
      if (type !== "all" && n.type !== type) return false;
      if (q && !(n.front + " " + n.back + " " + (n.tags || []).join(" ")).toLowerCase().includes(q)) return false;
      return true;
    });
    $("#noteEmpty").style.display = filtered.length ? "none" : "block";
    filtered.forEach((n) => {
      const card = document.createElement("div");
      card.className = "note-card";
      const tags = (n.tags || []).map((t) => `<span class="tag-pill">${escapeHtml(t)}</span>`).join("");
      card.innerHTML = `
        <div class="front">${escapeHtml(n.front)}</div>
        <div class="back">${escapeHtml(n.back)}
          <div class="meta"><span class="type-pill">${TYPE_LABELS[n.type] || "普通"}</span>${tags}</div>
        </div>
        <div class="actions">
          <button class="icon-btn edit" title="编辑">✏️</button>
          <button class="icon-btn del" title="删除">🗑️</button>
        </div>`;
      card.querySelector(".edit").onclick = () => openNoteModal(n.id);
      card.querySelector(".del").onclick = () => deleteNote(n.id);
      box.appendChild(card);
    });
  }

  function deleteNote(id) {
    if (!confirm("确定删除这条笔记吗？")) return;
    notes = notes.filter((n) => n.id !== id);
    saveNotes();
    renderNoteList();
    toast("已删除");
  }

  function openNoteModal(id) {
    editingNoteId = id;
    const n = id ? notes.find((x) => x.id === id) : null;
    $("#noteModalTitle").textContent = n ? "编辑笔记" : "新建笔记";
    $("#noteType").value = n ? n.type : "word";
    $("#noteFront").value = n ? n.front : "";
    $("#noteBack").value = n ? n.back : "";
    $("#noteTags").value = n ? (n.tags || []).join(", ") : "";
    updateNoteLabels();
    $("#noteModal").hidden = false;
  }

  function closeNoteModal() {
    $("#noteModal").hidden = true;
    editingNoteId = null;
  }

  function updateNoteLabels() {
    const t = $("#noteType").value;
    const map = { word: "正面 / 单词", qa: "正面 / 问题", concept: "正面 / 概念", general: "正面 / 标题" };
    const mapB = { word: "背面 / 释义", qa: "背面 / 答案", concept: "背面 / 说明", general: "背面 / 内容" };
    $("#frontLabel").textContent = map[t];
    $("#backLabel").textContent = mapB[t];
  }

  function saveNoteFromModal() {
    const front = $("#noteFront").value.trim();
    const back = $("#noteBack").value.trim();
    if (!front || !back) { toast("正面和背面都不能为空"); return; }
    const tags = $("#noteTags").value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    const data = { front, back, type: $("#noteType").value, tags };
    if (editingNoteId) {
      const n = notes.find((x) => x.id === editingNoteId);
      Object.assign(n, data);
    } else {
      notes.push(Object.assign({ id: uid(), createdAt: Date.now() }, data));
    }
    saveNotes();
    renderNoteList();
    closeNoteModal();
    toast("已保存");
  }

  // 导出 / 导入
  function download(filename, text, type) {
    const blob = new Blob([text], { type: type || "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function exportNotes() {
    if (!notes.length) { toast("没有可导出的笔记"); return; }
    download("笔记_" + stamp() + ".json", JSON.stringify(notes, null, 2));
    toast("已导出笔记 JSON");
  }

  function exportAll() {
    download("笔记备份_" + stamp() + ".json", JSON.stringify({ notes, settings }, null, 2));
    toast("已导出全部数据");
  }

  function stamp() {
    const d = new Date();
    return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
  }

  function importNotesFromFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (Array.isArray(data)) {
          data.forEach((n) => {
            if (n.front && n.back) notes.push(Object.assign({ id: uid(), tags: [], type: "general", createdAt: Date.now() }, n));
          });
          saveNotes(); renderNoteList();
          toast("已导入 " + data.length + " 条笔记");
        } else if (data && Array.isArray(data.notes)) {
          notes = data.notes;
          if (data.settings) settings = Object.assign(settings, data.settings);
          saveNotes(); saveSettings(); renderNoteList(); fillSettings();
          toast("已导入备份数据");
        } else {
          toast("文件格式不正确");
        }
      } catch (e) { toast("导入失败：文件不是有效 JSON"); }
    };
    reader.readAsText(file);
  }

  function clearAll() {
    if (!confirm("确定清空所有笔记数据吗？此操作不可恢复！")) return;
    notes = [];
    saveNotes();
    renderNoteList();
    toast("已清空");
  }

  // =========================================================
  // 第四部分：自我考核
  // =========================================================
  function isWrong(n) {
    return !!n._wrong;
  }

  function getQuizPool() {
    const scope = $("#quizScope").value;
    if (scope === "wrong") return notes.filter(isWrong);
    if (scope === "all") return notes.slice();
    return notes.filter((n) => n.type === scope);
  }

  function buildQuiz() {
    const mode = $("#quizMode").value;
    const count = $("#quizCount").value;
    let pool = getQuizPool().filter((n) => n.front && n.back);
    if (!pool.length) { toast("该范围内没有可用笔记"); return null; }
    pool = shuffle(pool);
    if (count !== "all") pool = pool.slice(0, parseInt(count, 10));
    return {
      mode,
      items: pool,
      index: 0,
      correct: 0,
      wrong: [],
      answered: false,
    };
  }

  function startQuiz() {
    const q = buildQuiz();
    if (!q) return;
    quizState = q;
    $("#quizSetup").hidden = true;
    $("#quizReport").hidden = true;
    $("#quizPanel").hidden = false;
    renderQuizItem();
  }

  function renderQuizItem() {
    const q = quizState;
    const item = q.items[q.index];
    const card = $("#quizCard");
    $("#quizIndex").textContent = `${q.index + 1} / ${q.items.length}`;
    $("#quizFill").style.width = ((q.index) / q.items.length * 100) + "%";
    $("#quizScore").textContent = `得分 ${q.correct}`;
    $("#quizFeedback").textContent = "";
    $("#quizFeedback").className = "quiz-feedback";
    $("#btnNext").hidden = true;
    q.answered = false;

    const typeLabel = TYPE_LABELS[item.type] || "普通";
    $("#quizTag").textContent = typeLabel;

    // 根据模式渲染题目
    if (q.mode === "choice") {
      renderChoice(item);
    } else if (q.mode === "dictation") {
      renderDictation(item);
    } else {
      renderFlash(item);
    }
  }

  function makeDistractors(correct, pool, n = 3) {
    const others = shuffle(pool.filter((p) => p.back !== correct).map((p) => p.back))
      .slice(0, n);
    // 不足时补占位
    while (others.length < n) others.push("（暂缺干扰项）");
    return others;
  }

  function renderChoice(item) {
    const card = $("#quizCard");
    const opts = makeDistractors(item.back, quizState.items);
    const options = shuffle([item.back, ...opts]);
    const host = $("#quizOptions");
    host.hidden = false;
    $("#quizInputRow").hidden = true;
    $("#quizQuestion").innerHTML = escapeHtml(item.front) +
      '<span class="sub">请选择正确的释义 / 答案</span>';
    host.innerHTML = "";
    options.forEach((opt) => {
      const btn = document.createElement("button");
      btn.className = "quiz-option";
      btn.textContent = opt;
      btn.onclick = () => {
        if (quizState.answered) return;
        quizState.answered = true;
        const ok = opt === item.back;
        if (ok) { quizState.correct++; btn.classList.add("correct"); }
        else {
          btn.classList.add("wrong");
          $$(".quiz-option").forEach((o) => {
            if (o.textContent === item.back) o.classList.add("correct");
          });
          quizState.wrong.push(item);
        }
        showFeedback(ok, item);
        $("#quizScore").textContent = `得分 ${quizState.correct}`;
        $$(".quiz-option").forEach((o) => (o.disabled = true));
        showNext();
      };
      host.appendChild(btn);
    });
  }

  function renderDictation(item) {
    const card = $("#quizCard");
    $("#quizOptions").hidden = true;
    $("#quizInputRow").hidden = false;
    $("#quizInput").value = "";
    $("#quizQuestion").innerHTML = escapeHtml(item.back) +
      '<span class="sub">请写出对应的单词 / 内容</span>';
    $("#quizInput").focus();
    $("#btnSubmitAnswer").onclick = () => submitDictation(item);
    $("#quizInput").onkeydown = (e) => { if (e.key === "Enter") submitDictation(item); };
  }

  function submitDictation(item) {
    if (quizState.answered) return;
    const val = $("#quizInput").value.trim();
    if (!val) { toast("请先输入答案"); return; }
    quizState.answered = true;
    const corrects = item.front.split(/[/／;；|]/).map((s) => normalize(s));
    const ok = corrects.includes(normalize(val));
    if (ok) quizState.correct++;
    else quizState.wrong.push(item);
    showFeedback(ok, item);
    $("#quizScore").textContent = `得分 ${quizState.correct}`;
    showNext();
  }

  function renderFlash(item) {
    const card = $("#quizCard");
    $("#quizOptions").hidden = true;
    $("#quizInputRow").hidden = true;
    $("#quizQuestion").innerHTML = "";
    let flipped = false;
    const host = document.createElement("div");
    host.className = "flash-host";
    const fc = document.createElement("div");
    fc.className = "flash-card";
    const hint = document.createElement("p");
    hint.className = "flash-hint";
    hint.textContent = "点击卡片翻面，然后自我评价";
    fc.innerHTML = `<div class="front-text">${escapeHtml(item.front)}</div>`;
    const grade = document.createElement("div");
    grade.className = "flash-grade";
    grade.style.display = "none";
    fc.onclick = () => {
      if (flipped) return;
      flipped = true;
      fc.innerHTML = `<div class="back-text">${escapeHtml(item.back)}</div>`;
      grade.style.display = "flex";
      hint.textContent = "选择你的掌握程度";
    };
    const mk = (label, okVal) => {
      const b = document.createElement("button");
      b.className = "btn " + (okVal ? "" : "danger");
      b.textContent = label;
      b.onclick = () => {
        if (quizState.answered) return;
        quizState.answered = true;
        if (okVal) quizState.correct++;
        else quizState.wrong.push(item);
        showFeedback(okVal, item);
        $("#quizScore").textContent = `得分 ${quizState.correct}`;
        showNext();
      };
      return b;
    };
    grade.append(mk("😊 认识", true), mk("😐 模糊", false), mk("😞 不认识", false));
    host.append(fc, hint, grade);
    $("#quizCard").insertBefore(host, $("#quizFeedback"));
  }

  function showFeedback(ok, item) {
    const fb = $("#quizFeedback");
    if (ok) {
      fb.textContent = "✅ 回答正确！";
      fb.className = "quiz-feedback ok";
    } else {
      fb.textContent = `❌ 回答错误，正确答案：${item.front}`;
      fb.className = "quiz-feedback no";
    }
  }

  function showNext() {
    const btn = $("#btnNext");
    btn.hidden = false;
    btn.textContent = quizState.index + 1 >= quizState.items.length ? "查看报告" : "下一题 →";
    btn.onclick = nextQuestion;
  }

  function nextQuestion() {
    quizState.index++;
    if (quizState.index >= quizState.items.length) {
      showReport();
    } else {
      // 清空上一题的临时 DOM
      $("#quizCard").querySelectorAll(".flash-host").forEach((e) => e.remove());
      renderQuizItem();
    }
  }

  function showReport() {
    quizState.index = 0;
    const q = quizState;
    $("#quizPanel").hidden = true;
    $("#quizReport").hidden = false;
    $("#rTotal").textContent = q.items.length;
    $("#rCorrect").textContent = q.correct;
    const wrong = q.items.length - q.correct;
    $("#rWrong").textContent = wrong;
    $("#rRate").textContent = q.items.length ? Math.round((q.correct / q.items.length) * 100) + "%" : "0%";

    // 更新错题标记
    const wrongIds = new Set(q.wrong.map((n) => n.id));
    notes.forEach((n) => { if (wrongIds.has(n.id)) n._wrong = true; });
    saveNotes();

    const box = $("#wrongList");
    box.innerHTML = "";
    if (!q.wrong.length) {
      box.innerHTML = '<div class="empty">太棒了，全部答对！🎉</div>';
    } else {
      q.wrong.forEach((n, i) => {
        const div = document.createElement("div");
        div.className = "note-card";
        div.innerHTML = `<div class="front">${i + 1}. ${escapeHtml(n.front)}</div>
          <div class="back">${escapeHtml(n.back)}</div>`;
        box.appendChild(div);
      });
    }
  }

  // =========================================================
  // 第五部分：设置
  // =========================================================
  function fillSettings() {
    $("#aiBaseUrl").value = settings.baseUrl || "";
    $("#aiModel").value = settings.model || "";
    $("#aiKey").value = settings.key || "";
  }

  function readSettings() {
    settings.baseUrl = $("#aiBaseUrl").value.trim();
    settings.model = $("#aiModel").value.trim();
    settings.key = $("#aiKey").value.trim();
    saveSettings();
    toast("设置已保存");
  }

  function updateQuizReadyHint() {
    $("#quizReadyHint").textContent = `当前共 ${notes.filter(n => n.front && n.back).length} 条可用笔记，错题 ${notes.filter(isWrong).length} 条。`;
  }

  // =========================================================
  // 事件绑定
  // =========================================================
  function bindEvents() {
    $$(".tab").forEach((t) => t.addEventListener("click", () => switchView(t.dataset.view)));
    $("#btnOcr").addEventListener("click", runOcr);
    $("#btnParse").addEventListener("click", parseFromRaw);
    $("#btnAiParse").addEventListener("click", aiParse);
    $("#btnClearRaw").addEventListener("click", () => { $("#rawText").value = ""; $("#resultPanel").hidden = true; $("#parsedPreview").innerHTML = ""; });

    $("#searchInput").addEventListener("input", renderNoteList);
    $("#typeFilter").addEventListener("change", renderNoteList);
    $("#btnAddNote").addEventListener("click", () => openNoteModal(null));
    $("#btnNoteCancel").addEventListener("click", closeNoteModal);
    $("#btnNoteSave").addEventListener("click", saveNoteFromModal);
    $("#noteType").addEventListener("change", updateNoteLabels);
    $("#noteModal").addEventListener("click", (e) => { if (e.target.id === "noteModal") closeNoteModal(); });

    $("#btnExport").addEventListener("click", exportNotes);
    $("#btnImport").addEventListener("click", () => $("#importFile").click());

    $("#btnStartQuiz").addEventListener("click", startQuiz);
    $("#btnRetryWrong").addEventListener("click", () => {
      $("#quizScope").value = "wrong";
      $("#quizReport").hidden = true;
      $("#quizSetup").hidden = false;
      updateQuizReadyHint();
    });
    $("#btnBackSetup").addEventListener("click", () => {
      $("#quizReport").hidden = true;
      $("#quizPanel").hidden = true;
      $("#quizSetup").hidden = false;
      updateQuizReadyHint();
    });
    $("#quizScope").addEventListener("change", updateQuizReadyHint);

    $("#btnSaveSettings").addEventListener("click", readSettings);
    $("#btnExportAll").addEventListener("click", exportAll);
    $("#btnImportAll").addEventListener("click", () => $("#importFile").click());
    $("#btnClearAll").addEventListener("click", clearAll);

    const importFile = $("#importFile");
    importFile.addEventListener("change", () => {
      if (importFile.files[0]) importNotesFromFile(importFile.files[0]);
      importFile.value = "";
    });
  }

  function init() {
    loadNotes();
    loadSettings();
    saveNotes(); // 刷新数量
    fillSettings();
    renderNoteList();
    bindEvents();
    updateQuizReadyHint();
  }

  init();
})();