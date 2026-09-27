    // ── 图标体系（SF Symbols 风格自绘 stroke 图标）────────────
    // 只经 uiIcon() 输出；aria-hidden 由函数统一注入。
    // 注意：分片中不得出现 'use strict'，由 scripts/build_frontend.py 统一写在 bundle 第一行。

    var UI_ICONS = {
      logo: '<path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4"/>',
      settings: '<path d="M4 8h8M16 8h4M4 16h4M12 16h8"/><circle cx="14" cy="8" r="2.4"/><circle cx="10" cy="16" r="2.4"/>',
      refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3L19.5 9"/><path d="M19.5 4.5V9H15"/>',
      'rotate-cw': '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3L19.5 9"/><path d="M19.5 4.5V9H15"/>',
      activity: '<path d="M3 12h4l2.5-6 5 12 2.5-6h4"/>',
      document: '<path d="M7 3.5h7l4 4V20.5H7z"/><path d="M14 3.5v4h4M10 12h5M10 15.5h5"/>',
      'x-circle': '<circle cx="12" cy="12" r="8.5"/><path d="m9 9 6 6M15 9l-6 6"/>',
      search: '<circle cx="11" cy="11" r="6.5"/><path d="M15.8 15.8 21 21"/>',
      plus: '<path d="M12 5v14M5 12h14"/>',
      close: '<path d="M6 6l12 12M18 6L6 18"/>',
      'chev-left': '<path d="M14.5 5.5 8 12l6.5 6.5"/>',
      'chev-right': '<path d="M9.5 5.5 16 12l-6.5 6.5"/>',
      upload: '<path d="M12 16V5M7.5 9.5 12 5l4.5 4.5"/><path d="M4 16.5v1.8A2.7 2.7 0 0 0 6.7 21h10.6a2.7 2.7 0 0 0 2.7-2.7v-1.8"/>',
      download: '<path d="M12 5v11M7.5 11.5 12 16l4.5-4.5"/><path d="M4 16.5v1.8A2.7 2.7 0 0 0 6.7 21h10.6a2.7 2.7 0 0 0 2.7-2.7v-1.8"/>',
      'book-open': '<path d="M12 6.5C10.5 5 8 4.5 4.5 4.5v13C8 17.5 10.5 18 12 19.5c1.5-1.5 4-2 7.5-2v-13C16 4.5 13.5 5 12 6.5z"/><path d="M12 6.5v13"/>',
      mic: '<path d="M12 3.5a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0v-5a3 3 0 0 1 3-3z"/><path d="M6.5 11.5a5.5 5.5 0 0 0 11 0M12 17v3.5M9 20.5h6"/>',
      rss: '<path d="M5 5.5a13.5 13.5 0 0 1 13.5 13.5"/><path d="M5 11.5a7.5 7.5 0 0 1 7.5 7.5"/><circle cx="5.8" cy="18.2" r="1.4" fill="currentColor" stroke="none"/>',
      trash: '<path d="M4.5 7h15M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7M6.5 7l.8 12.1A1.9 1.9 0 0 0 9.2 21h5.6a1.9 1.9 0 0 0 1.9-1.9L17.5 7"/><path d="M10 11v6M14 11v6"/>',
      'check-circle': '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 12.2l2.4 2.4 4.6-5"/>',
      'alert-circle': '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.8v5M12 16.4v.2"/>',
      info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 7.8v.2"/>',
      check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
      'type-minus': '<path d="M4.5 17 8.5 7l4 10M6.2 13.5h4.6"/><path d="M15.5 12H20"/>',
      'type-plus': '<path d="M4.5 17 8.5 7l4 10M6.2 13.5h4.6"/><path d="M17.75 9.75v4.5M15.5 12h4.5"/>',
      sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/>',
      moon: '<path d="M20 13.5A8 8 0 1 1 10.5 4 6.5 6.5 0 0 0 20 13.5z"/>',
      auto: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none"/>'
    };

    function uiIcon(name, cls) {
      var body = UI_ICONS[name];
      if (!body) return '';
      return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"' + (cls ? ' class="' + cls + '"' : '') + ' aria-hidden="true">' + body + '</svg>';
    }
