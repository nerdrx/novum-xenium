const stylesheetTags = import('./stylesheets.mjs').then(({ stylesheetLinkTags }) => stylesheetLinkTags());

function withAppStyles(html) {
  const marker = '<!-- APP_STYLESHEET_LINKS -->';
  if (!html.includes(marker)) throw new Error('fixture is missing its app stylesheet marker');
  return stylesheetTags.then(tags => html.replace(marker, tags));
}

module.exports = { withAppStyles };
