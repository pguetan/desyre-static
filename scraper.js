const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');

const TARGET_HOST = 'https://desyres-portfolio-template.webflow.io';
const WORKSPACE_DIR = __dirname;
const ASSETS_DIR = path.join(WORKSPACE_DIR, 'assets');

// Directories for local assets
const DIRS = {
  css: path.join(ASSETS_DIR, 'css'),
  js: path.join(ASSETS_DIR, 'js'),
  images: path.join(ASSETS_DIR, 'images'),
  fonts: path.join(ASSETS_DIR, 'fonts')
};

// Pages to scrape
const PAGES = [
  { path: '/', local: 'index.html' },
  { path: '/license', local: 'license.html' },
  { path: '/style-guide', local: 'style-guide.html' },
  { path: '/404', local: '404.html' },
  { path: '/changelog', local: 'changelog.html' },
  { path: '/single-post/autonomous-ai', local: 'single-post/autonomous-ai.html' },
  { path: '/single-post/predictive-models', local: 'single-post/predictive-models.html' },
  { path: '/single-post/smart-chat-system', local: 'single-post/smart-chat-system.html' },
  { path: '/single-post/vision-ai', local: 'single-post/vision-ai.html' }
];

// Map of remote URL -> local asset path relative to workspace root
const assetMap = new Map();

// Helper to ensure directories exist
async function ensureDirectories() {
  for (const dir of Object.values(DIRS)) {
    await fsPromises.mkdir(dir, { recursive: true });
  }
}

// Utility to get relative path prefix based on nesting level
function getRelativePrefix(localPath) {
  const depth = localPath.split('/').length - 1;
  return depth > 0 ? '../'.repeat(depth) : './';
}

// Helper to download a file
async function downloadFile(urlStr, destPath) {
  if (urlStr.startsWith('//')) {
    urlStr = 'https:' + urlStr;
  }
  
  // Clean query params for downloading
  const cleanUrl = urlStr.split('?')[0];

  try {
    const response = await axios({
      method: 'get',
      url: cleanUrl,
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    
    await fsPromises.mkdir(path.dirname(destPath), { recursive: true });
    await fsPromises.writeFile(destPath, response.data);
    console.log(`Downloaded: ${cleanUrl} -> ${path.relative(WORKSPACE_DIR, destPath)}`);
    return true;
  } catch (err) {
    console.error(`Failed to download ${urlStr}: ${err.message}`);
    return false;
  }
}

// Map remote asset URL to local filename and download it
async function getOrDownloadAsset(urlStr, type) {
  if (!urlStr || urlStr.startsWith('data:') || urlStr.startsWith('javascript:')) {
    return urlStr;
  }

  // Handle absolute or host-relative paths
  let absoluteUrl = urlStr;
  if (urlStr.startsWith('/')) {
    absoluteUrl = TARGET_HOST + urlStr;
  } else if (!urlStr.startsWith('http://') && !urlStr.startsWith('https://') && !urlStr.startsWith('//')) {
    // Relative to home page if not matching protocol
    absoluteUrl = TARGET_HOST + '/' + urlStr;
  }

  // Normalise remote URL
  if (absoluteUrl.startsWith('//')) {
    absoluteUrl = 'https:' + absoluteUrl;
  }

  if (assetMap.has(absoluteUrl)) {
    return assetMap.get(absoluteUrl);
  }

  // Determine local filename
  const cleanUrl = absoluteUrl.split('?')[0];
  const basename = path.basename(new URL(cleanUrl).pathname) || 'asset';
  
  // Format filename cleanly
  let safeName = basename.replace(/[^a-zA-Z0-9.\-_]/g, '_');
  
  // Deduplicate safeName if needed
  let destPath = path.join(DIRS[type], safeName);
  let counter = 1;
  while (fs.existsSync(destPath) && assetMap.get(absoluteUrl) === undefined) {
    const ext = path.extname(safeName);
    const base = path.basename(safeName, ext);
    const newName = `${base}_${counter}${ext}`;
    destPath = path.join(DIRS[type], newName);
    safeName = newName;
    counter++;
  }

  // Attempt download
  const success = await downloadFile(absoluteUrl, destPath);
  if (success) {
    // Save relative path from workspace root
    const localRelPath = `assets/${type}/${safeName}`;
    assetMap.set(absoluteUrl, localRelPath);
    
    // For CSS files, post-process font/image references inside
    if (type === 'css') {
      await processCssFile(destPath, absoluteUrl);
    }
    
    return localRelPath;
  }
  
  return urlStr;
}

// Process downloaded CSS files to resolve external URLs (fonts, bg images)
async function processCssFile(filePath, originalUrl) {
  let content = await fsPromises.readFile(filePath, 'utf8');
  const cssDir = path.dirname(filePath);
  
  // Regex to find url(...) references
  const urlRegex = /url\(['"]?([^'")]+)['"]?\)/g;
  let match;
  const urlsToReplace = [];

  while ((match = urlRegex.exec(content)) !== null) {
    const assetUrl = match[1];
    if (assetUrl.startsWith('data:')) continue;

    // Resolve relative asset URLs in remote CSS based on remote CSS location
    let absoluteAssetUrl = assetUrl;
    if (!assetUrl.startsWith('http://') && !assetUrl.startsWith('https://') && !assetUrl.startsWith('//')) {
      // Resolve against CSS original url
      absoluteAssetUrl = new URL(assetUrl, originalUrl).href;
    }
    urlsToReplace.push({ matchStr: match[0], originalUrl: absoluteAssetUrl, relUrl: assetUrl });
  }

  // Download assets and replace in CSS
  for (const item of urlsToReplace) {
    // Determine asset type
    let assetType = 'images';
    const ext = path.extname(item.originalUrl.split('?')[0]).toLowerCase();
    if (['.woff', '.woff2', '.ttf', '.otf', '.eot'].includes(ext)) {
      assetType = 'fonts';
    }

    const localRelPathFromRoot = await getOrDownloadAsset(item.originalUrl, assetType);
    if (localRelPathFromRoot && localRelPathFromRoot !== item.originalUrl) {
      // Relative path from CSS directory to local asset
      // CSS is in `/assets/css/`, assets in `/assets/fonts/` or `/assets/images/`
      // So relative path from `/assets/css/` is `../fonts/filename` or `../images/filename`
      const filename = path.basename(localRelPathFromRoot);
      const relativeAssetPath = `../${assetType}/${filename}`;
      
      content = content.replace(item.matchStr, `url('${relativeAssetPath}')`);
    }
  }

  await fsPromises.writeFile(filePath, content, 'utf8');
}

// Fetch Google Fonts (Inter) and download them for offline use
async function processGoogleFonts() {
  console.log('Fetching Google Fonts...');
  const fontsUrl = 'https://fonts.googleapis.com/css?family=Inter:300,400,500,600,700';
  
  try {
    const response = await axios.get(fontsUrl, {
      headers: {
        // Use a modern browser user agent to get woff2 font formats
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    let cssContent = response.data;
    
    // Find all font URLs
    const fontUrlRegex = /url\((https:\/\/fonts\.gstatic\.com\/[^\)]+)\)/g;
    let match;
    const fontsToDownload = [];
    
    while ((match = fontUrlRegex.exec(cssContent)) !== null) {
      fontsToDownload.push(match[1]);
    }
    
    // Download and map fonts
    for (const remoteUrl of fontsToDownload) {
      const filename = path.basename(new URL(remoteUrl).pathname);
      const destPath = path.join(DIRS.fonts, filename);
      const success = await downloadFile(remoteUrl, destPath);
      if (success) {
        // Rewrite rule in CSS to point to local fonts folder
        cssContent = cssContent.replaceAll(remoteUrl, `../fonts/${filename}`);
      }
    }
    
    // Save Google Fonts CSS stylesheet
    const localCssPath = path.join(DIRS.css, 'google-fonts.css');
    await fsPromises.writeFile(localCssPath, cssContent, 'utf8');
    console.log('Created local google-fonts.css');
    return 'assets/css/google-fonts.css';
  } catch (err) {
    console.error('Failed to download Google Fonts:', err.message);
    return null;
  }
}

// Scrape a page, download local assets, rewrite HTML
async function scrapePage(pageInfo, localFontsCssPath) {
  const url = TARGET_HOST + pageInfo.path;
  console.log(`\nScraping Page: ${url}`);
  
  try {
    const response = await axios.get(url);
    const $ = cheerio.load(response.data);
    const prefix = getRelativePrefix(pageInfo.local);

    // 1. Process stylesheet links
    const stylesheets = $('link[rel="stylesheet"]').toArray();
    for (const el of stylesheets) {
      const href = $(el).attr('href');
      if (href) {
        const localRelPath = await getOrDownloadAsset(href, 'css');
        $(el).attr('href', prefix + localRelPath);
        // Remove integrity/crossorigin checking to avoid CORS issues locally
        $(el).removeAttr('integrity');
        $(el).removeAttr('crossorigin');
      }
    }

    // 2. Process JS script tags
    const scripts = $('script').toArray();
    for (const el of scripts) {
      const src = $(el).attr('src');
      if (src) {
        // Skip analytics, webfont loader scripts
        if (src.includes('analytics.js') || src.includes('google-analytics')) {
          $(el).remove();
          continue;
        }
        
        let localRelPath = await getOrDownloadAsset(src, 'js');
        $(el).attr('src', prefix + localRelPath);
        $(el).removeAttr('integrity');
        $(el).removeAttr('crossorigin');
      }
    }

    // Remove Google WebFont script and standard loader script since we will load locally
    $('script').each((idx, el) => {
      const htmlContent = $(el).html();
      const src = $(el).attr('src');
      if (src && src.includes('webfont.js')) {
        $(el).remove();
      } else if (htmlContent && htmlContent.includes('WebFont.load')) {
        $(el).remove();
      }
    });

    // Add local google fonts link
    if (localFontsCssPath) {
      $('head').append(`<link href="${prefix}${localFontsCssPath}" rel="stylesheet" type="text/css" />\n`);
    }

    // 3. Process Images (img src and srcset)
    const images = $('img').toArray();
    for (const el of images) {
      const src = $(el).attr('src');
      if (src) {
        const localRelPath = await getOrDownloadAsset(src, 'images');
        $(el).attr('src', prefix + localRelPath);
      }

      const srcset = $(el).attr('srcset');
      if (srcset) {
        const parts = srcset.split(',');
        const newParts = [];
        for (const part of parts) {
          const trimmed = part.trim();
          const spaceIdx = trimmed.indexOf(' ');
          if (spaceIdx !== -1) {
            const imgUrl = trimmed.substring(0, spaceIdx);
            const descriptor = trimmed.substring(spaceIdx);
            const localRelPath = await getOrDownloadAsset(imgUrl, 'images');
            newParts.push(`${prefix}${localRelPath}${descriptor}`);
          } else {
            const localRelPath = await getOrDownloadAsset(trimmed, 'images');
            newParts.push(`${prefix}${localRelPath}`);
          }
        }
        $(el).attr('srcset', newParts.join(', '));
      }
    }

    // 4. Process Favicon links
    const favicons = $('link[rel*="icon"], link[rel="apple-touch-icon"]').toArray();
    for (const el of favicons) {
      const href = $(el).attr('href');
      if (href) {
        const localRelPath = await getOrDownloadAsset(href, 'images');
        $(el).attr('href', prefix + localRelPath);
      }
    }

    // 5. Rewrite inline style background-images
    $('[style]').each(async (idx, el) => {
      let style = $(el).attr('style');
      if (style && style.includes('url(')) {
        const urlRegex = /url\(['"]?([^\)'"]+)['"]?\)/g;
        let match;
        while ((match = urlRegex.exec(style)) !== null) {
          const imgUrl = match[1];
          if (!imgUrl.startsWith('data:')) {
            const localRelPath = await getOrDownloadAsset(imgUrl, 'images');
            style = style.replace(match[0], `url('${prefix}${localRelPath}')`);
          }
        }
        $(el).attr('style', style);
      }
    });

    // 6. Rewrite absolute links pointing to subpages (e.g. /license -> ./license.html)
    $('a').each((idx, el) => {
      const href = $(el).attr('href');
      if (href) {
        // Find matching page in PAGES list
        const matchPage = PAGES.find(p => p.path === href || p.path === href + '/' || href === TARGET_HOST + p.path);
        if (matchPage) {
          // Compute correct relative link from current page to target page
          // e.g. from `/single-post/autonomous-ai` (localPath: `single-post/autonomous-ai.html`)
          // to `/license` (localPath: `license.html`), relative link is `../license.html`
          const targetRelPath = matchPage.local;
          const currentDepth = pageInfo.local.split('/').length - 1;
          
          let relativeLink = '';
          if (currentDepth > 0) {
            relativeLink = '../'.repeat(currentDepth) + targetRelPath;
          } else {
            relativeLink = './' + targetRelPath;
          }
          
          $(el).attr('href', relativeLink);
          console.log(`Rewrote link: ${href} -> ${relativeLink}`);
        } else if (href === '/' || href === '') {
          const currentDepth = pageInfo.local.split('/').length - 1;
          const relativeLink = currentDepth > 0 ? '../index.html' : './index.html';
          $(el).attr('href', relativeLink);
        }
      }
    });

    // Ensure directory for target HTML page exists
    const destHtmlPath = path.join(WORKSPACE_DIR, pageInfo.local);
    await fsPromises.mkdir(path.dirname(destHtmlPath), { recursive: true });
    
    // Save processed HTML
    await fsPromises.writeFile(destHtmlPath, $.html(), 'utf8');
    console.log(`Saved page: ${pageInfo.local}`);
  } catch (err) {
    console.error(`Error scraping page ${pageInfo.path}:`, err.message);
  }
}

// Main execution flow
async function main() {
  console.log('--- STARTING OFFLINE STATIC SITE CONVERSION ---');
  
  await ensureDirectories();
  
  // Download Google Fonts (Inter) first
  const localFontsCssPath = await processGoogleFonts();
  
  // Scrape each page
  for (const pageInfo of PAGES) {
    await scrapePage(pageInfo, localFontsCssPath);
  }
  
  console.log('\n--- CONVERSION COMPLETED ---');
  console.log(`Downloaded ${assetMap.size} assets successfully.`);
}

main().catch(err => {
  console.error('Fatal Error in scraper script:', err);
  process.exit(1);
});
