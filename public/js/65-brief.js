    // ── 稿件导读（渐进式阅读）────────────────────────────────
    // 第一层：正文顶部的导读卡（TL;DR、要点、原话、适合谁读、全文时长）+「阅读全文」；
    // 第二层：每个小节标题下一行淡色小结（可在「排版」里隐藏，偏好只存本机）；
    // 第三层：全文。导读来自稿件元数据 DTO（公开 /api/public/articles/:id，主人 /api/control/articles/:id），
    // 旧稿件 brief = null 时什么都不渲染。
    // 注意：分片中不得出现 'use strict'，由 scripts/build_frontend.mjs 统一写在 bundle 第一行。

    var SECTION_SUMMARIES_KEY = 'reader_section_summaries';

    function articleMetaUrl(taskId) {
      var id = encodeURIComponent(String(taskId || ''));
      return IS_MANAGE ? appUrl('/api/control/articles/' + id) : appUrl('/api/public/articles/' + id);
    }

    /** 读取导读；任何失败（404、网络、旧稿件）都返回 null，绝不阻塞正文。 */
    // 导读请求的等待上限：正文与它并行读取，导读迟迟不回来时按 null 处理，绝不拖住正文。
    var BRIEF_LOAD_TIMEOUT_MS = 4000;

    function loadArticleBrief(taskId) {
      var request = fetch(articleMetaUrl(taskId))
        .then(function (response) { return response.ok ? response.json() : null; })
        .then(function (data) {
          var brief = data && data.brief;
          return brief && typeof brief === 'object' && typeof brief.tldr === 'string' ? brief : null;
        })
        .catch(function () { return null; });
      var timeout = new Promise(function (resolve) { setTimeout(function () { resolve(null); }, BRIEF_LOAD_TIMEOUT_MS); });
      return Promise.race([request, timeout]);
    }

    /** 与服务端 normalizeHeading 同一规则：去强调符号与收尾 #、合并空白、小写。 */
    function briefHeadingKey(text) {
      return String(text == null ? '' : text).replace(/[*_`]/g, '').replace(/\s+#+\s*$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
    }

    function briefEl(tag, className, text) {
      var el = document.createElement(tag);
      if (className) el.className = className;
      if (text != null) el.textContent = String(text);
      return el;
    }

    function briefLabel(key) {
      var label = briefEl('div', 'reader-brief-label', t(key));
      label.setAttribute('data-i18n', key);
      return label;
    }

    function refreshArticleBriefLabels() {
      document.querySelectorAll('.reader-brief-time[data-minutes]').forEach(function (el) {
        el.textContent = t('reader.brief_full_minutes', el.getAttribute('data-minutes'));
      });
    }

    function buildBriefCard(brief) {
      var card = briefEl('section', 'reader-brief');
      card.setAttribute('aria-label', t('reader.brief_kicker'));
      card.setAttribute('data-i18n-aria-label', 'reader.brief_kicker');

      var head = briefEl('div', 'reader-brief-head');
      var kicker = briefEl('span', 'reader-brief-kicker', t('reader.brief_kicker'));
      kicker.setAttribute('data-i18n', 'reader.brief_kicker');
      head.appendChild(kicker);
      var minutes = Number(brief.reading_minutes) || 0;
      if (minutes > 0) {
        var time = briefEl('span', 'reader-brief-time', t('reader.brief_full_minutes', minutes));
        time.setAttribute('data-minutes', String(minutes));
        head.appendChild(time);
      }
      card.appendChild(head);

      card.appendChild(briefEl('p', 'reader-brief-tldr', brief.tldr));

      var points = Array.isArray(brief.key_points) ? brief.key_points : [];
      if (points.length) {
        card.appendChild(briefLabel('reader.brief_key_points'));
        var list = briefEl('ul', 'reader-brief-points');
        points.forEach(function (point) { list.appendChild(briefEl('li', null, point)); });
        card.appendChild(list);
      }

      var quotes = Array.isArray(brief.quotes) ? brief.quotes : [];
      if (quotes.length) {
        card.appendChild(briefLabel('reader.brief_quotes'));
        quotes.forEach(function (quote) {
          var figure = briefEl('figure', 'reader-brief-quote');
          figure.appendChild(briefEl('p', null, quote.text));
          if (quote.speaker) figure.appendChild(briefEl('figcaption', null, '— ' + quote.speaker));
          card.appendChild(figure);
        });
      }

      if (brief.audience) {
        card.appendChild(briefLabel('reader.brief_audience'));
        card.appendChild(briefEl('p', 'reader-brief-audience', brief.audience));
      }

      var cta = briefEl('button', 'reader-brief-cta');
      cta.type = 'button';
      var ctaText = briefEl('span', null, t('reader.brief_read_full'));
      ctaText.setAttribute('data-i18n', 'reader.brief_read_full');
      cta.appendChild(ctaText);
      cta.insertAdjacentHTML('beforeend', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6"/></svg>');
      cta.addEventListener('click', function () {
        var next = card.nextElementSibling;
        if (next) next.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      card.appendChild(cta);
      return card;
    }

    /**
     * 在已渲染的正文上叠加导读：顶部导读卡 + 匹配标题下的小节摘要。
     * 导读卡不使用 h1–h3（不进入大纲目录）；概念链接跳过导读文字（见 70-concepts.js）。
     */
    function decorateManuscriptWithBrief(body, brief) {
      if (!body || !brief) return;
      var summaries = {};
      (Array.isArray(brief.sections) ? brief.sections : []).forEach(function (section) {
        if (section && section.heading && section.summary) summaries[briefHeadingKey(section.heading)] = section.summary;
      });
      body.querySelectorAll('h1, h2, h3').forEach(function (heading) {
        var key = briefHeadingKey(heading.textContent);
        if (!Object.prototype.hasOwnProperty.call(summaries, key)) return;
        var line = briefEl('p', 'section-summary', summaries[key]);
        heading.insertAdjacentElement('afterend', line);
        delete summaries[key];
      });
      body.insertBefore(buildBriefCard(brief), body.firstChild);
    }

    function setSectionSummaries(mode, skipSave) {
      var value = mode === 'off' ? 'off' : 'on';
      var reader = document.getElementById('manuscript-reader');
      if (reader) reader.dataset.sectionSummaries = value;
      document.querySelectorAll('[data-summaries]').forEach(function (btn) {
        var active = btn.dataset.summaries === value;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-checked', active ? 'true' : 'false');
      });
      // 纯本机阅读便利（两种模式都存 localStorage）：不新增 D1 偏好列。
      if (!skipSave) { try { localStorage.setItem(SECTION_SUMMARIES_KEY, value); } catch (ignore) {} }
    }

    (function initSectionSummaries() {
      var saved = null;
      try { saved = localStorage.getItem(SECTION_SUMMARIES_KEY); } catch (ignore) {}
      setSectionSummaries(saved === 'off' ? 'off' : 'on', true);
      document.querySelectorAll('[data-summaries]').forEach(function (btn) {
        btn.addEventListener('click', function () { setSectionSummaries(btn.dataset.summaries); });
      });
    })();
