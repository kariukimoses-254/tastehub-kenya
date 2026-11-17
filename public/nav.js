/* One shared navigation bar for every public page (customers + staff portals). */
(function () {
  'use strict';

  var customer = [
    { label: 'Home', href: '/' },
    { label: 'Menu', href: '/menu.html' },
    { label: 'About', href: '/about.html' },
    { label: 'Blog', href: '/blog.html' },
    { label: 'Contact', href: '/contact.html' }
  ];

  var staff = [
    { label: 'HQ Admin', href: '/admin.html' },
    { label: 'Branch', href: '/branch.html' },
    { label: 'Driver', href: '/driver.html' },
    { label: 'Confirm', href: '/confirm.html' }
  ];

  var path = (location.pathname || '/').replace(/index\.html$/, '/');

  function isActive(href) {
    if (href === '/') return path === '/' || path === '';
    return path === href;
  }

  function render(items) {
    return items.map(function (item) {
      var current = isActive(item.href);
      return '<a href="' + item.href + '"' +
        (current ? ' class="active" aria-current="page"' : '') + '>' +
        item.label + '</a>';
    }).join('');
  }

  var nav = document.createElement('nav');
  nav.className = 'th-nav';
  nav.setAttribute('aria-label', 'Site navigation');
  nav.innerHTML =
    '<div class="inner">' +
      '<a class="brand" href="/">Taste<b>Hub</b> <span>Kenya</span></a>' +
      '<div class="group">' + render(customer) + '</div>' +
      '<div class="group staff"><span class="label">Staff</span>' + render(staff) + '</div>' +
    '</div>';

  var css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = '/nav.css';
  document.head.appendChild(css);

  document.body.insertBefore(nav, document.body.firstChild);
})();
