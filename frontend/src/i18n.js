// Every user-facing string in the app lives here, keyed by a stable id.
//
// Two rules keep this honest. First, only *chrome* is translated: labels the
// app itself writes. A tea's name, flavour notes and origin are the user's own
// words and are shown back exactly as typed, in whatever language they typed
// them. Second, the fixed vocabularies (tea type, grade, rarity) are translated
// for display only — the stored value stays the canonical English string, so a
// collection saved in Italian still filters, imports and exports identically in
// Chinese.

import React, { createContext, useContext, useEffect, useMemo, useState } from "react";

export const LANGUAGES = [
  { code: "en", label: "English", short: "EN" },
  { code: "it", label: "Italiano", short: "IT" },
  { code: "zh", label: "中文", short: "中" },
];

export const DEFAULT_LANG = "en";

const STORAGE_KEY = "cha:lang:v1";

// Exported as the raw source of truth. translate() falls back to English, which
// means a gap in another language is invisible at runtime — the suite reads the
// tables directly so a missing or untranslated key fails the build instead.
export const TABLES = {
  en: {
    "app.title": "The Tea Cabinet",
    "app.subtitle": "A personal inventory of Chinese tea",
    "app.entries_one": "{count} entry",
    "app.entries_other": "{count} entries",

    "lang.label": "Language",

    "header.saving": "Saving…",
    "header.saved": "Saved",
    "header.notSaved": "Not saved",
    "header.import": "Import",
    "header.export": "Export",
    "header.dedupe": "Dedupe",
    "header.dedupeTitle": "Merge duplicate entries",
    "header.addTea": "Add tea",

    "search.placeholder": "Search name, flavour, origin…",
    "search.clear": "Clear search",

    "filter.all": "All",
    "filter.caffeine": "Caffeine",
    "filter.allCaffeine": "All levels",

    "caffeine.None": "Caffeine-free",
    "caffeine.Low": "Low",
    "caffeine.Medium": "Medium",
    "caffeine.High": "High",
    "caffeine.Unlisted": "Unlisted",
    "caffeine.hint.Low": "up to 25 mg",
    "caffeine.hint.Medium": "26–50 mg",
    "caffeine.hint.High": "over 50 mg",

    "state.opening": "Opening the cabinet…",
    "state.notLost": "Your teas are not lost — they are on the server. Reload once it is reachable again.",
    "state.tryAgain": "Try again",

    "empty.noMatchTitle": "No teas match that",
    "empty.noMatchSub": "Try a different search or clear the filters.",
    "empty.clearFilters": "Clear filters",
    "empty.cabinetTitle": "The cabinet is empty",
    "empty.cabinetSub": "Add your first tea by hand, or snap a photo of the packet to fill it in.",
    "empty.addFirst": "Add your first tea",

    "card.untitled": "Untitled tea",

    "edit.titleEdit": "Edit tea",
    "edit.titleAdd": "Add a tea",
    "edit.readLabel": "Read the label",
    "edit.readLabelSub": "Upload a photo of the packet and Claude will translate the Chinese and fill in the fields for you to review.",
    "edit.uploadPhoto": "Upload photo",
    "edit.replacePhoto": "Replace photo",
    "edit.reread": "Re-read",
    "edit.packetAlt": "Tea packet",
    "edit.scanning": "Reading the label — translating and grading…",
    "edit.scanned": "Fields filled from the label. Edit anything below before saving.",
    "edit.saveChanges": "Save changes",
    "edit.saveToCollection": "Save to collection",

    "field.englishName": "English name",
    "field.chineseName": "Chinese name 中文名",
    "field.teaType": "Tea type",
    "field.harvestYear": "Harvest year",
    "field.flavourNotes": "Flavour notes",
    "field.waterTemp": "Water temp (°C)",
    "field.steepTime": "Steep time",
    "field.caffeine": "Caffeine / gaiwan cup",
    "field.origin": "Origin",
    "field.grade": "Grade",
    "field.rarity": "Rarity",
    "field.reasoning": "Grading reasoning",

    "ph.englishName": "Dragon Well",
    "ph.chineseName": "西湖龙井",
    "ph.harvestYear": "2024",
    "ph.flavourNotes": "Chestnut, fresh grass, gentle sweetness",
    "ph.brewTemp": "80",
    "ph.steepTime": "1–2 min",
    "ph.caffeine": "~30 mg",
    "ph.origin": "West Lake, Hangzhou, Zhejiang",
    "ph.reasoning": "Why this grade / rarity — from the label and general knowledge of Chinese tea grading.",

    "select.choose": "Choose…",
    "select.unknown": "Unknown",

    "detail.flavour": "Flavour",
    "detail.brewing": "Brewing",
    "detail.water": "water",
    "detail.steep": "steep",
    "detail.caffeinePerCup": "caffeine / cup",
    "detail.provenance": "Provenance",
    "detail.harvest": "Harvest {year}",
    "detail.whyGrade": "Why this grade",
    "detail.removeConfirm": "Remove this tea?",
    "detail.keep": "Keep",

    "ctx.title": "Caffeine in context",
    "ctx.intro": "How a gaiwan cup of this tea compares with common drinks (approximate, per typical serving).",
    "ctx.foot": "Figures are rough averages; actual caffeine varies with leaf amount, water temperature, steep time, and which infusion you drink.",
    "ctx.thisTea": "This tea ({name})",
    "ctx.selected": "selected",
    "ctx.mg": "{n} mg",

    "ref.herbal": "Herbal infusion",
    "ref.decaf": "Decaf coffee",
    "ref.green": "Green tea",
    "ref.black": "Black tea",
    "ref.cola": "Cola",
    "ref.energy": "Energy drink",
    "ref.espresso": "Espresso",
    "ref.coffee": "Brewed coffee",
    "ref.note.free": "caffeine-free",
    "ref.note.cup": "8 oz cup",
    "ref.note.glass": "8 oz",
    "ref.note.can": "12 oz can",
    "ref.note.shot": "1 shot",

    "common.close": "Close",
    "common.cancel": "Cancel",
    "common.remove": "Remove",
    "common.edit": "Edit",

    "toast.teaUpdated": "Tea updated",
    "toast.teaAdded": "Tea added to your collection",
    "toast.removed": "Removed from collection",
    "toast.offline": "Offline — showing your last saved copy",
    "toast.nothingToExport": "Nothing to export yet",
    "toast.exported_one": "Exported {count} tea",
    "toast.exported_other": "Exported {count} teas",
    "toast.exportFailed": "Export failed",
    "toast.badImportFile": "Couldn't read that file — expected a Tea Cabinet export",
    "toast.importComplete": "Import complete — {summary}",
    "toast.dupesRemoved_one": "Removed {count} duplicate tea",
    "toast.dupesRemoved_other": "Removed {count} duplicate teas",
    "toast.noDupes": "No duplicates found",

    "import.added": "{count} added",
    "import.updated": "{count} updated",
    "import.photosSkipped_one": "{count} photo skipped",
    "import.photosSkipped_other": "{count} photos skipped",
    "import.none": "no teas found",

    "err.needName": "Give the tea at least an English or Chinese name.",
    "err.notImage": "That doesn't look like an image. Upload a JPEG, PNG, or photo of the packet.",
    "err.readFile": "Couldn't read that file. Try another photo.",
    "err.readLabel": "Couldn't read that label. Fill the fields in by hand.",
    "err.labelRead": "Label read — review the fields below",

    // Keyed off ApiError.code so a failure reads in the chosen language.
    "err.api.auth": "Your session has expired. Reload the page to sign in again.",
    "err.api.tooLarge": "That is too large to save.",
    "err.api.photoTooLarge": "That photo is too large.",
    "err.api.rateLimited": "Too many requests just now — wait a moment and try again.",
    "err.api.server": "The server could not store that. Nothing was saved.",
    "err.api.refused": "The server refused that request (HTTP {status}).",
    "err.api.unreadable": "The server sent back something unreadable.",
    "err.api.network": "Could not reach the server. Your change is not saved.",
    "err.api.photoNetwork": "Could not upload that photo.",
    "err.sessionExpired": "Your session expired — reload the page to sign in again.",
    "err.saveFailed": "Could not save your change.",
    "err.unreachable": "Could not reach the server.",
    "err.loadFailed": "Could not load your collection.",
  },

  it: {
    "app.title": "La Credenza del Tè",
    "app.subtitle": "Un inventario personale di tè cinese",
    "app.entries_one": "{count} voce",
    "app.entries_other": "{count} voci",

    "lang.label": "Lingua",

    "header.saving": "Salvataggio…",
    "header.saved": "Salvato",
    "header.notSaved": "Non salvato",
    "header.import": "Importa",
    "header.export": "Esporta",
    "header.dedupe": "Deduplica",
    "header.dedupeTitle": "Unisci le voci duplicate",
    "header.addTea": "Aggiungi tè",

    "search.placeholder": "Cerca nome, aroma, origine…",
    "search.clear": "Cancella la ricerca",

    "filter.all": "Tutti",
    "filter.caffeine": "Caffeina",
    "filter.allCaffeine": "Tutti i livelli",

    "caffeine.None": "Senza caffeina",
    "caffeine.Low": "Bassa",
    "caffeine.Medium": "Media",
    "caffeine.High": "Alta",
    "caffeine.Unlisted": "Non indicata",
    "caffeine.hint.Low": "fino a 25 mg",
    "caffeine.hint.Medium": "26–50 mg",
    "caffeine.hint.High": "oltre 50 mg",

    "state.opening": "Apertura della credenza…",
    "state.notLost": "I tuoi tè non sono perduti: sono sul server. Ricarica la pagina quando sarà di nuovo raggiungibile.",
    "state.tryAgain": "Riprova",

    "empty.noMatchTitle": "Nessun tè corrisponde",
    "empty.noMatchSub": "Prova un'altra ricerca oppure azzera i filtri.",
    "empty.clearFilters": "Azzera i filtri",
    "empty.cabinetTitle": "La credenza è vuota",
    "empty.cabinetSub": "Aggiungi il tuo primo tè a mano, oppure fotografa la confezione per compilarlo.",
    "empty.addFirst": "Aggiungi il tuo primo tè",

    "card.untitled": "Tè senza nome",

    "edit.titleEdit": "Modifica tè",
    "edit.titleAdd": "Aggiungi un tè",
    "edit.readLabel": "Leggi l'etichetta",
    "edit.readLabelSub": "Carica una foto della confezione: Claude tradurrà il cinese e compilerà i campi che potrai rivedere.",
    "edit.uploadPhoto": "Carica foto",
    "edit.replacePhoto": "Sostituisci foto",
    "edit.reread": "Rileggi",
    "edit.packetAlt": "Confezione di tè",
    "edit.scanning": "Lettura dell'etichetta — traduzione e valutazione…",
    "edit.scanned": "Campi compilati dall'etichetta. Modifica ciò che vuoi prima di salvare.",
    "edit.saveChanges": "Salva le modifiche",
    "edit.saveToCollection": "Salva nella collezione",

    "field.englishName": "Nome inglese",
    "field.chineseName": "Nome cinese 中文名",
    "field.teaType": "Tipo di tè",
    "field.harvestYear": "Anno di raccolta",
    "field.flavourNotes": "Note aromatiche",
    "field.waterTemp": "Temp. acqua (°C)",
    "field.steepTime": "Tempo di infusione",
    "field.caffeine": "Caffeina / tazza gaiwan",
    "field.origin": "Origine",
    "field.grade": "Categoria",
    "field.rarity": "Rarità",
    "field.reasoning": "Motivazione della valutazione",

    "ph.englishName": "Dragon Well",
    "ph.chineseName": "西湖龙井",
    "ph.harvestYear": "2024",
    "ph.flavourNotes": "Castagna, erba fresca, dolcezza delicata",
    "ph.brewTemp": "80",
    "ph.steepTime": "1–2 min",
    "ph.caffeine": "~30 mg",
    "ph.origin": "Lago dell'Ovest, Hangzhou, Zhejiang",
    "ph.reasoning": "Perché questa categoria / rarità — dall'etichetta e dalla conoscenza generale della classificazione del tè cinese.",

    "select.choose": "Scegli…",
    "select.unknown": "Sconosciuta",

    "detail.flavour": "Aroma",
    "detail.brewing": "Infusione",
    "detail.water": "acqua",
    "detail.steep": "infusione",
    "detail.caffeinePerCup": "caffeina / tazza",
    "detail.provenance": "Provenienza",
    "detail.harvest": "Raccolto {year}",
    "detail.whyGrade": "Perché questa categoria",
    "detail.removeConfirm": "Rimuovere questo tè?",
    "detail.keep": "Mantieni",

    "ctx.title": "La caffeina a confronto",
    "ctx.intro": "Come una tazza gaiwan di questo tè si confronta con le bevande più comuni (valori approssimativi, per porzione tipica).",
    "ctx.foot": "Le cifre sono medie approssimative; la caffeina reale varia con la quantità di foglie, la temperatura dell'acqua, il tempo di infusione e quale infusione si beve.",
    "ctx.thisTea": "Questo tè ({name})",
    "ctx.selected": "selezionato",
    "ctx.mg": "{n} mg",

    "ref.herbal": "Infuso di erbe",
    "ref.decaf": "Caffè decaffeinato",
    "ref.green": "Tè verde",
    "ref.black": "Tè nero",
    "ref.cola": "Cola",
    "ref.energy": "Energy drink",
    "ref.espresso": "Espresso",
    "ref.coffee": "Caffè filtro",
    "ref.note.free": "senza caffeina",
    "ref.note.cup": "tazza da 240 ml",
    "ref.note.glass": "240 ml",
    "ref.note.can": "lattina da 355 ml",
    "ref.note.shot": "1 shot",

    "common.close": "Chiudi",
    "common.cancel": "Annulla",
    "common.remove": "Rimuovi",
    "common.edit": "Modifica",

    "toast.teaUpdated": "Tè aggiornato",
    "toast.teaAdded": "Tè aggiunto alla tua collezione",
    "toast.removed": "Rimosso dalla collezione",
    "toast.offline": "Offline — mostriamo l'ultima copia salvata",
    "toast.nothingToExport": "Non c'è ancora nulla da esportare",
    "toast.exported_one": "Esportato {count} tè",
    "toast.exported_other": "Esportati {count} tè",
    "toast.exportFailed": "Esportazione non riuscita",
    "toast.badImportFile": "Impossibile leggere quel file — serve un export de La Credenza del Tè",
    "toast.importComplete": "Importazione completata — {summary}",
    "toast.dupesRemoved_one": "Rimosso {count} tè duplicato",
    "toast.dupesRemoved_other": "Rimossi {count} tè duplicati",
    "toast.noDupes": "Nessun duplicato trovato",

    "import.added": "{count} aggiunti",
    "import.updated": "{count} aggiornati",
    "import.photosSkipped_one": "{count} foto saltata",
    "import.photosSkipped_other": "{count} foto saltate",
    "import.none": "nessun tè trovato",

    "err.needName": "Dai al tè almeno un nome inglese o cinese.",
    "err.notImage": "Non sembra un'immagine. Carica un JPEG, un PNG o una foto della confezione.",
    "err.readFile": "Impossibile leggere quel file. Prova un'altra foto.",
    "err.readLabel": "Impossibile leggere quell'etichetta. Compila i campi a mano.",
    "err.labelRead": "Etichetta letta — controlla i campi qui sotto",

    "err.api.auth": "La tua sessione è scaduta. Ricarica la pagina per accedere di nuovo.",
    "err.api.tooLarge": "È troppo grande per essere salvato.",
    "err.api.photoTooLarge": "Quella foto è troppo grande.",
    "err.api.rateLimited": "Troppe richieste in questo momento — attendi un attimo e riprova.",
    "err.api.server": "Il server non è riuscito a salvare. Non è stato salvato nulla.",
    "err.api.refused": "Il server ha rifiutato la richiesta (HTTP {status}).",
    "err.api.unreadable": "Il server ha risposto qualcosa di illeggibile.",
    "err.api.network": "Impossibile raggiungere il server. La tua modifica non è stata salvata.",
    "err.api.photoNetwork": "Impossibile caricare quella foto.",
    "err.sessionExpired": "La tua sessione è scaduta — ricarica la pagina per accedere di nuovo.",
    "err.saveFailed": "Impossibile salvare la tua modifica.",
    "err.unreachable": "Impossibile raggiungere il server.",
    "err.loadFailed": "Impossibile caricare la tua collezione.",
  },

  zh: {
    "app.title": "茶柜",
    "app.subtitle": "个人中国茶收藏",
    "app.entries_one": "{count} 款",
    "app.entries_other": "{count} 款",

    "lang.label": "语言",

    "header.saving": "保存中…",
    "header.saved": "已保存",
    "header.notSaved": "未保存",
    "header.import": "导入",
    "header.export": "导出",
    "header.dedupe": "去重",
    "header.dedupeTitle": "合并重复的条目",
    "header.addTea": "添加茶",

    "search.placeholder": "搜索名称、风味、产地…",
    "search.clear": "清除搜索",

    "filter.all": "全部",
    "filter.caffeine": "咖啡因",
    "filter.allCaffeine": "全部含量",

    "caffeine.None": "无咖啡因",
    "caffeine.Low": "低",
    "caffeine.Medium": "中",
    "caffeine.High": "高",
    "caffeine.Unlisted": "未标注",
    "caffeine.hint.Low": "最多 25 毫克",
    "caffeine.hint.Medium": "26–50 毫克",
    "caffeine.hint.High": "超过 50 毫克",

    "state.opening": "正在打开茶柜…",
    "state.notLost": "你的茶并没有丢失，它们都在服务器上。等服务器恢复后重新加载即可。",
    "state.tryAgain": "重试",

    "empty.noMatchTitle": "没有匹配的茶",
    "empty.noMatchSub": "换一个搜索词，或清除筛选条件。",
    "empty.clearFilters": "清除筛选",
    "empty.cabinetTitle": "茶柜是空的",
    "empty.cabinetSub": "手动添加第一款茶，或拍下包装照片自动填写。",
    "empty.addFirst": "添加第一款茶",

    "card.untitled": "未命名的茶",

    "edit.titleEdit": "编辑茶",
    "edit.titleAdd": "添加一款茶",
    "edit.readLabel": "识别标签",
    "edit.readLabelSub": "上传包装照片，Claude 会翻译中文并填好各字段，供你核对。",
    "edit.uploadPhoto": "上传照片",
    "edit.replacePhoto": "更换照片",
    "edit.reread": "重新识别",
    "edit.packetAlt": "茶叶包装",
    "edit.scanning": "正在识别标签 — 翻译并评级…",
    "edit.scanned": "已根据标签填写字段。保存前可随意修改。",
    "edit.saveChanges": "保存修改",
    "edit.saveToCollection": "存入收藏",

    "field.englishName": "英文名",
    "field.chineseName": "中文名",
    "field.teaType": "茶类",
    "field.harvestYear": "采摘年份",
    "field.flavourNotes": "风味描述",
    "field.waterTemp": "水温（°C）",
    "field.steepTime": "浸泡时间",
    "field.caffeine": "咖啡因 / 每盖碗",
    "field.origin": "产地",
    "field.grade": "等级",
    "field.rarity": "稀有度",
    "field.reasoning": "评级理由",

    "ph.englishName": "Dragon Well",
    "ph.chineseName": "西湖龙井",
    "ph.harvestYear": "2024",
    "ph.flavourNotes": "板栗香、青草气、回甘柔和",
    "ph.brewTemp": "80",
    "ph.steepTime": "1–2 分钟",
    "ph.caffeine": "约 30 毫克",
    "ph.origin": "浙江杭州西湖",
    "ph.reasoning": "为何是这个等级 / 稀有度 — 依据标签以及中国茶分级的常识。",

    "select.choose": "请选择…",
    "select.unknown": "未知",

    "detail.flavour": "风味",
    "detail.brewing": "冲泡",
    "detail.water": "水温",
    "detail.steep": "浸泡",
    "detail.caffeinePerCup": "咖啡因 / 每杯",
    "detail.provenance": "来源",
    "detail.harvest": "{year} 年采摘",
    "detail.whyGrade": "评级理由",
    "detail.removeConfirm": "要移除这款茶吗？",
    "detail.keep": "保留",

    "ctx.title": "咖啡因对比",
    "ctx.intro": "一盖碗此茶与常见饮品的比较（按典型分量，数值为近似值）。",
    "ctx.foot": "以上为粗略平均值；实际咖啡因含量会随投茶量、水温、浸泡时间以及第几泡而变化。",
    "ctx.thisTea": "这款茶（{name}）",
    "ctx.selected": "所选",
    "ctx.mg": "{n} 毫克",

    "ref.herbal": "花草茶",
    "ref.decaf": "低因咖啡",
    "ref.green": "绿茶",
    "ref.black": "红茶",
    "ref.cola": "可乐",
    "ref.energy": "能量饮料",
    "ref.espresso": "浓缩咖啡",
    "ref.coffee": "滴滤咖啡",
    "ref.note.free": "无咖啡因",
    "ref.note.cup": "240 毫升一杯",
    "ref.note.glass": "240 毫升",
    "ref.note.can": "355 毫升一罐",
    "ref.note.shot": "一份",

    "common.close": "关闭",
    "common.cancel": "取消",
    "common.remove": "移除",
    "common.edit": "编辑",

    "toast.teaUpdated": "已更新该茶",
    "toast.teaAdded": "已加入你的收藏",
    "toast.removed": "已从收藏中移除",
    "toast.offline": "离线 — 显示上次保存的副本",
    "toast.nothingToExport": "暂时没有可导出的内容",
    "toast.exported_one": "已导出 {count} 款茶",
    "toast.exported_other": "已导出 {count} 款茶",
    "toast.exportFailed": "导出失败",
    "toast.badImportFile": "无法读取该文件 — 需要茶柜导出的文件",
    "toast.importComplete": "导入完成 — {summary}",
    "toast.dupesRemoved_one": "已移除 {count} 款重复的茶",
    "toast.dupesRemoved_other": "已移除 {count} 款重复的茶",
    "toast.noDupes": "未发现重复",

    "import.added": "新增 {count} 款",
    "import.updated": "更新 {count} 款",
    "import.photosSkipped_one": "跳过 {count} 张照片",
    "import.photosSkipped_other": "跳过 {count} 张照片",
    "import.none": "未找到任何茶",

    "err.needName": "请至少填写英文名或中文名。",
    "err.notImage": "这似乎不是图片。请上传 JPEG、PNG 或包装照片。",
    "err.readFile": "无法读取该文件。请换一张照片。",
    "err.readLabel": "无法识别该标签。请手动填写各字段。",
    "err.labelRead": "标签已识别 — 请核对下方字段",

    "err.api.auth": "登录状态已过期。请刷新页面重新登录。",
    "err.api.tooLarge": "内容过大，无法保存。",
    "err.api.photoTooLarge": "这张照片太大了。",
    "err.api.rateLimited": "请求过于频繁 — 请稍候再试。",
    "err.api.server": "服务器无法保存。没有任何内容被保存。",
    "err.api.refused": "服务器拒绝了该请求（HTTP {status}）。",
    "err.api.unreadable": "服务器返回了无法解析的内容。",
    "err.api.network": "无法连接服务器。你的修改未被保存。",
    "err.api.photoNetwork": "无法上传该照片。",
    "err.sessionExpired": "登录状态已过期 — 请刷新页面重新登录。",
    "err.saveFailed": "无法保存你的修改。",
    "err.unreachable": "无法连接服务器。",
    "err.loadFailed": "无法加载你的收藏。",
  },
};

// Fixed vocabularies, translated for display only. The key is always the
// canonical English value that is stored on the record — never the translation,
// so switching language can never rewrite or orphan saved data.
const VOCAB = {
  type: {
    it: { Green: "Verde", White: "Bianco", Yellow: "Giallo", Oolong: "Oolong", Black: "Nero", Dark: "Scuro", "Pu-erh": "Pu-erh", Scented: "Aromatizzato", Herbal: "Tisana", Other: "Altro" },
    // Note that English "Black" is 红茶 (red tea) and English "Dark" is 黑茶.
    // Translating them literally is the classic way to mislabel a whole shelf.
    zh: { Green: "绿茶", White: "白茶", Yellow: "黄茶", Oolong: "乌龙茶", Black: "红茶", Dark: "黑茶", "Pu-erh": "普洱", Scented: "花茶", Herbal: "花草茶", Other: "其他" },
  },
  grade: {
    it: { Everyday: "Quotidiano", Standard: "Standard", Premium: "Pregiato", Competition: "Da concorso", "Imperial / Gong Ting": "Imperiale / Gong Ting" },
    zh: { Everyday: "口粮", Standard: "标准", Premium: "精品", Competition: "赛级", "Imperial / Gong Ting": "宫廷" },
  },
  rarity: {
    it: { Common: "Comune", Uncommon: "Poco comune", Rare: "Raro", "Very rare": "Molto raro" },
    zh: { Common: "常见", Uncommon: "少见", Rare: "稀有", "Very rare": "极稀有" },
  },
};

export function isSupported(code) {
  return LANGUAGES.some((l) => l.code === code);
}

function interpolate(template, vars) {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole
  );
}

// A missing translation falls back to English rather than showing a raw key:
// a half-translated screen is usable, a screen of dotted identifiers is not.
export function translate(lang, key, vars) {
  const table = TABLES[lang] || TABLES[DEFAULT_LANG];
  const base = TABLES[DEFAULT_LANG];
  let lookup = key;
  if (vars && typeof vars.count === "number") {
    const plural = `${key}_${vars.count === 1 ? "one" : "other"}`;
    if (table[plural] || base[plural]) lookup = plural;
  }
  const template = table[lookup] ?? base[lookup] ?? key;
  return interpolate(template, vars);
}

export function makeT(lang) {
  return (key, vars) => translate(lang, key, vars);
}

// Display form of a stored vocabulary value. Unknown values (an older record, a
// hand-edited import) pass through untouched instead of vanishing.
export function vocab(lang, kind, value) {
  if (!value) return value;
  return VOCAB[kind]?.[lang]?.[value] ?? value;
}

// An ApiError carries a code; anything else is shown as-is. The English message
// on the error is the last resort, so a new failure mode is never silent.
export function translateError(lang, err, fallbackKey = "err.saveFailed") {
  if (err && err.code) return translate(lang, `err.api.${err.code}`, { status: err.status });
  if (err && err.message) return err.message;
  return translate(lang, fallbackKey);
}

export function readStoredLang() {
  try {
    const saved = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (saved && isSupported(saved)) return saved;
  } catch (e) {
    // Private-browsing modes throw on access. Falling through to the browser
    // preference is fine; the toggle just will not persist.
  }
  const nav = globalThis.navigator?.languages?.[0] || globalThis.navigator?.language || "";
  const primary = String(nav).toLowerCase().split("-")[0];
  return isSupported(primary) ? primary : DEFAULT_LANG;
}

function storeLang(lang) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, lang);
  } catch (e) {
    // Not persisting is a worse session, not a broken one.
  }
}

const LangContext = createContext(null);

export function LanguageProvider({ children }) {
  const [lang, setLangState] = useState(readStoredLang);

  const setLang = (next) => {
    if (!isSupported(next)) return;
    setLangState(next);
    storeLang(next);
  };

  // Screen readers and the browser's own translation prompt both key off this,
  // so it has to follow the toggle rather than stay at the document's default.
  useEffect(() => {
    if (globalThis.document) globalThis.document.documentElement.lang = lang;
  }, [lang]);

  const value = useMemo(() => ({ lang, setLang, t: makeT(lang) }), [lang]);
  return React.createElement(LangContext.Provider, { value }, children);
}

export function useI18n() {
  const ctx = useContext(LangContext);
  if (!ctx) throw new Error("useI18n must be used inside a LanguageProvider");
  return ctx;
}
