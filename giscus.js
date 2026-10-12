(function () {
  var DARK_THEMES = ['coal', 'navy', 'ayu'];

  function currentTheme() {
    var cls = document.documentElement.classList;
    for (var i = 0; i < DARK_THEMES.length; i++) {
      if (cls.contains(DARK_THEMES[i])) return 'dark';
    }
    return 'light';
  }

  function inject() {
    var main = document.querySelector('#mdbook-content main');
    if (!main || document.getElementById('giscus-container')) return;

    var container = document.createElement('div');
    container.id = 'giscus-container';
    container.style.cssText = 'margin-top:2em;padding-top:1em;border-top:1px solid var(--theme-popup-border)';

    var script = document.createElement('script');
    script.src = 'https://giscus.app/client.js';
    // 请在 https://giscus.app/ 获取您的配置
    script.setAttribute('data-repo', 'KMiri-rs/book');
    script.setAttribute('data-repo-id', 'R_kgDOVFv34A');
    script.setAttribute('data-category', 'General');
    script.setAttribute('data-category-id', 'DIC_kwDOVFv34M4DIAAA');
    script.setAttribute('data-mapping', 'pathname');
    script.setAttribute('data-strict', '1');
    script.setAttribute('data-reactions-enabled', '1');
    script.setAttribute('data-emit-metadata', '0');
    script.setAttribute('data-input-position', 'top');
    script.setAttribute('data-theme', currentTheme());
    script.setAttribute('data-lang', 'en');
    script.setAttribute('data-loading', 'lazy');
    script.setAttribute('crossorigin', 'anonymous');
    script.async = true;

    container.appendChild(script);
    main.appendChild(container);
  }

  // 监听 mdBook 主题切换，同步更新 giscus 配色
  var themeObserver = new MutationObserver(function () {
    var frame = document.querySelector('iframe.giscus-frame');
    if (frame) {
      frame.contentWindow.postMessage(
        { giscus: { setConfig: { theme: currentTheme() } } },
        'https://giscus.app'
      );
    }
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
