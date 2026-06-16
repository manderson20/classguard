// domainClassifier.js — keyword-based domain categorization
// No external API calls. Pure pattern matching against domain name parts.
// Used for domains not found in UT1/Shallalist lists.

const RULES = [
  // High-confidence adult patterns — these domain parts are almost always adult content
  { slug: 'adult', weight: 90, keywords: [
    'porn','xxx','sex','nude','naked','erotic','hentai','milf','fetish',
    'escort','stripper','onlyfans','nsfw','adult','lewd','cum','dick',
    'pussy','boobs','tits','anal','creampie','gangbang','jerkmate',
    'brazzers','naughty','playboy','hustler','xvideos','xhamster',
    'redtube','youporn','pornhub','rule34','gelbooru','danbooru',
  ]},

  // Gambling
  { slug: 'gambling', weight: 85, keywords: [
    'casino','poker','betting','wager','slots','roulette','blackjack',
    'sportsbook','betway','draftkings','fanduel','bovada','bet365',
    'lottery','lotto','jackpot','bingo','sportsbetting','oddsshark',
  ]},

  // Drugs & alcohol
  { slug: 'drugs_alcohol', weight: 80, keywords: [
    'weed','cannabis','marijuana','thc','cbd','dispensary','kratom',
    'cocaine','heroin','meth','amphetamine','psychedelic','shroom',
    'eddibles','420','bong','vape','ecstasy','mdma','lsd',
  ]},

  // Weapons
  { slug: 'weapons', weight: 75, keywords: [
    'gunbroker','armslist','budsgunshop','guns','ammo','ammunition',
    'firearm','pistol','revolver','ar15','ak47','rifle','shotgun',
    'glock','springfield','beretta','assault-rifle','explosives',
  ]},

  // Violence
  { slug: 'violence', weight: 80, keywords: [
    'gore','bestgore','liveleak','rotten','ogrish','shock-site','snuff',
  ]},

  // Hate speech
  { slug: 'hate_speech', weight: 85, keywords: [
    'dailystormer','stormfront','infowars','whitenationalist',
    'neonazi','aryan','kkk',
  ]},

  // Proxy / VPN / circumvention
  { slug: 'proxy_vpn', weight: 70, keywords: [
    'proxy','hideip','anonymizer','unblocksite','bypassfilter',
    'torguard','nordvpn','expressvpn','privatevpn','cyberghost',
    'hidemyass','surfshark','mullvad','ipvanish','vpngate','protonvpn',
    'ultrasurf','psiphon','freegate','lantern',
  ]},

  // Phishing / fraud — harder to catch by name, but some patterns exist
  { slug: 'phishing', weight: 60, keywords: [
    'login-verify','account-secure','paypal-update','apple-id-verify',
    'microsoft-verify','bankverify',
  ]},

  // Malware / hacking
  { slug: 'malware', weight: 75, keywords: [
    'hackforums','hacking-tools','keylogger','trojan','ransomware',
    'cracking','warez','darkweb','exploit-db','metasploit',
  ]},

  // Torrent / P2P
  { slug: 'torrent', weight: 75, keywords: [
    'torrent','thepiratebay','1337x','rarbg','nyaa','kickass',
    'pirate','warez','cracked','nulled','filehosting',
  ]},

  // Social media
  { slug: 'social_media', weight: 80, keywords: [
    'facebook','instagram','tiktok','snapchat','twitter','x.com',
    'pinterest','tumblr','reddit','linkedin','myspace','vk.com',
    'weibo','discord','threads',
  ]},

  // Gaming
  { slug: 'gaming', weight: 75, keywords: [
    'roblox','minecraft','fortnite','steam','epicgames','battlenet',
    'leagueoflegends','valorant','pubg','overwatch','genshin','freefire',
    'kongregate','newgrounds','armorgames','y8games','friv',
  ]},

  // Streaming
  { slug: 'streaming', weight: 80, keywords: [
    'netflix','hulu','disneyplus','hbomax','peacock','paramount',
    'twitch','youtube','vimeo','dailymotion','crunchyroll','funimation',
    'primevideo','appletv','pluto','tubi','spotify','soundcloud',
  ]},

  // Messaging
  { slug: 'messaging', weight: 75, keywords: [
    'whatsapp','telegram','signal','viber','kik','snapchat',
    'groupme','line-app','skype','teams','slack','zoom','webex',
  ]},

  // Dating
  { slug: 'dating', weight: 80, keywords: [
    'tinder','bumble','hinge','match','eharmony','okcupid',
    'plentyoffish','zoosk','grindr','scruff','seeking','sugardaddy',
  ]},
];

// Build a flat lookup: keyword → { slug, weight }
const KEYWORD_INDEX = new Map();
for (const rule of RULES) {
  for (const kw of rule.keywords) {
    if (!KEYWORD_INDEX.has(kw)) KEYWORD_INDEX.set(kw, []);
    KEYWORD_INDEX.get(kw).push({ slug: rule.slug, weight: rule.weight });
  }
}

/**
 * Extract searchable tokens from a domain.
 * "sub.casino-poker.co.uk" → ["sub", "casino", "poker", "co", "uk", "casino-poker"]
 */
function tokenize(domain) {
  const clean = domain.toLowerCase().replace(/\.$/, '');
  const parts = clean.split('.');
  const tokens = new Set();
  for (const part of parts) {
    tokens.add(part);
    // Also split hyphenated parts
    for (const seg of part.split('-')) {
      if (seg.length >= 3) tokens.add(seg);
    }
  }
  return [...tokens];
}

/**
 * Classify a domain by keyword scoring.
 * Returns { slug, confidence } or null if no match above threshold.
 */
function classify(domain) {
  const tokens  = tokenize(domain);
  const scores  = new Map(); // slug → max weight seen

  for (const token of tokens) {
    const matches = KEYWORD_INDEX.get(token);
    if (matches) {
      for (const { slug, weight } of matches) {
        scores.set(slug, Math.max(scores.get(slug) || 0, weight));
      }
    }
  }

  if (scores.size === 0) return null;

  // Pick highest-scoring category
  let best = null, bestScore = 0;
  for (const [slug, score] of scores) {
    if (score > bestScore) { best = slug; bestScore = score; }
  }

  // Only return if confidence is meaningful
  if (bestScore < 60) return null;

  return { slug: best, confidence: bestScore };
}

module.exports = { classify };
