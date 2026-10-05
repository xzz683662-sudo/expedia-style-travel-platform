/**
 * ---------------------------------------------------------------------------
 * Global city descriptors
 * ---------------------------------------------------------------------------
 *
 * One entry per city in the catalogue. Each descriptor holds the facts a
 * product needs and that never change between products: the anchor point used
 * for generated coordinates, the timezone, the currency, and the local colour
 * (language, address style) used to make copy feel written for that place
 * rather than machine-translated.
 *
 * The six product factories in `seed-global.ts` consume these, so adding a
 * city here is all that is required to give it a full, bilingual, six-category
 * catalogue.
 */

export type CityDescriptor = {
  /** Matches `Destination.slug` in `seed-data.ts`. */
  slug: string;
  /** City name as shown to guests, in English. */
  name: string;
  /** 中文城市名. */
  nameZh: string;
  /**
   * ISO 4217. Every variant of this city's products prices in this currency.
   *
   * Uniformly `USD`: the platform settled on a single settlement currency, so a
   * local currency here would only reintroduce a conversion at display time.
   */
  currency: string;
  /** IANA zone, used for service dates and slot times. */
  timezone: string;
  /** Landmark coordinate used as the anchor for generated product coords. */
  anchor: { lat: number; lng: number };
  /** Spreads generated coordinates around the anchor (in degrees). */
  spread: number;
  /** Primary local language, used for the "guided in" field. */
  language: string;
  /** Typical street/place name style, e.g. "Rue de Rivoli, 75001 Paris". */
  addressStyle: string;
  /** Where a private guide normally meets a guest, e.g. "hotel lobby". */
  meetingStyle: string;
  /** A defining characteristic worth weaving into premium copy. */
  signature: { en: string; zh: string };
};

/**
 * Ordered to match the merchandising priority in the storefront: Western
 * Europe first, then North America, then Asia-Pacific.
 */
export const CITIES: CityDescriptor[] = [
  // ===================== Western Europe — United Kingdom ====================
  {
    slug: 'london',
    name: 'London',
    nameZh: '伦敦',
    currency: 'USD',
    timezone: 'Europe/London',
    anchor: { lat: 51.5074, lng: -0.1278 },
    spread: 0.022,
    language: 'English',
    addressStyle: 'Westminster, London SW1A 2AA',
    meetingStyle: 'your hotel lobby, or a pre-agreed central address',
    signature: {
      en: 'royal residences, a world-class museum circuit and the West End',
      zh: '皇家官邸、世界级美术馆与西区剧院',
    },
  },
  {
    slug: 'edinburgh',
    name: 'Edinburgh',
    nameZh: '爱丁堡',
    currency: 'USD',
    timezone: 'Europe/London',
    anchor: { lat: 55.9533, lng: -3.1883 },
    spread: 0.02,
    language: 'English',
    addressStyle: 'Royal Mile, Edinburgh EH1 1QS',
    meetingStyle: 'your hotel on the Royal Mile, or the guide’s stand at the esplanade',
    signature: {
      en: 'a medieval Old Town on an extinct volcano, with the Highlands beyond',
      zh: '建在死火山上的中世纪老城，北面即是高地',
    },
  },
  {
    slug: 'bath',
    name: 'Bath',
    nameZh: '巴斯',
    currency: 'USD',
    timezone: 'Europe/London',
    anchor: { lat: 51.3811, lng: -2.359 },
    spread: 0.016,
    language: 'English',
    addressStyle: 'Abbey Churchyard, Bath BA1 1LY',
    meetingStyle: 'the Georgian hall of your Bath address',
    signature: {
      en: 'Georgian honey-stone architecture built over Roman thermal springs',
      zh: '建在罗马温泉之上的乔治亚式蜜色石建筑',
    },
  },

  // ================================ France =================================
  {
    slug: 'paris',
    name: 'Paris',
    nameZh: '巴黎',
    currency: 'USD',
    timezone: 'Europe/Paris',
    anchor: { lat: 48.8566, lng: 2.3522 },
    spread: 0.024,
    language: 'French',
    addressStyle: 'Rue de Rivoli, 75001 Paris',
    meetingStyle: 'the lobby of your Paris address, or by the glass pyramid',
    signature: {
      en: 'the museums of the Left Bank and the ateliers of the Right Bank',
      zh: '左岸的博物馆群与右岸的匠人工坊',
    },
  },
  {
    slug: 'nice',
    name: 'Nice',
    nameZh: '尼斯',
    currency: 'USD',
    timezone: 'Europe/Paris',
    anchor: { lat: 43.7102, lng: 7.262 },
    spread: 0.018,
    language: 'French',
    addressStyle: 'Promenade des Anglais, 06000 Nice',
    meetingStyle: 'your hotel on the Promenade, or the forecourt of the Opéra',
    signature: {
      en: 'Belle Époque arcades, the Cimiez quarter and the calanques of Èze',
      zh: '美好年代的拱廊、西米耶街区与埃兹的卡朗格',
    },
  },
  {
    slug: 'lyon',
    name: 'Lyon',
    nameZh: '里昂',
    currency: 'USD',
    timezone: 'Europe/Paris',
    anchor: { lat: 45.764, lng: 4.8357 },
    spread: 0.019,
    language: 'French',
    addressStyle: "Place Bellecour, 69002 Lyon",
    meetingStyle: 'the Place Bellecour fountain, or your hotel reception',
    signature: {
      en: 'two rivers, silk-weaving history and bouchons that have cooked for centuries',
      zh: '两江交汇、丝织传统与百年老字号小酒馆',
    },
  },

  // ================================ Italy =================================
  {
    slug: 'rome',
    name: 'Rome',
    nameZh: '罗马',
    currency: 'USD',
    timezone: 'Europe/Rome',
    anchor: { lat: 41.9028, lng: 12.4964 },
    spread: 0.024,
    language: 'Italian',
    addressStyle: 'Piazza Venezia, 00186 Roma',
    meetingStyle: 'the atrium of your hotel, or the fountain on Piazza Venezia',
    signature: {
      en: 'the Colosseum, the Vatican and the lanes of Trastevere',
      zh: '斗兽场、梵蒂冈与特拉斯提弗列的小巷',
    },
  },
  {
    slug: 'florence',
    name: 'Florence',
    nameZh: '佛罗伦萨',
    currency: 'USD',
    timezone: 'Europe/Rome',
    anchor: { lat: 43.7696, lng: 11.2558 },
    spread: 0.019,
    language: 'Italian',
    addressStyle: 'Piazza del Duomo, 50122 Firenze',
    meetingStyle: 'the side entrance of your hotel, or the Loggia del Pesce',
    signature: {
      en: 'Brunelleschi’s dome, Uffizi sculpture and the kitchens of the Oltrarno',
      zh: '布鲁内莱斯基穹顶、乌菲兹雕塑与 Oltrarno 区的家常餐桌',
    },
  },
  {
    slug: 'venice',
    name: 'Venice',
    nameZh: '威尼斯',
    currency: 'USD',
    timezone: 'Europe/Rome',
    anchor: { lat: 45.4408, lng: 12.3155 },
    spread: 0.015,
    language: 'Italian',
    addressStyle: 'Piazza San Marco, 00124 Venezia',
    meetingStyle: 'the landing at your hotel’s private pontoon',
    signature: {
      en: 'a lagoon city of cicchetti and campanile, best at first light',
      zh: '一座由小食、钟楼与晨光构成的水上城市',
    },
  },

  // ================================ Spain =================================
  {
    slug: 'barcelona',
    name: 'Barcelona',
    nameZh: '巴塞罗那',
    currency: 'USD',
    timezone: 'Europe/Madrid',
    anchor: { lat: 41.3851, lng: 2.1734 },
    spread: 0.023,
    language: 'Catalan & Spanish',
    addressStyle: 'Passeig de Gràcia, 08008 Barcelona',
    meetingStyle: 'the Passeig de Gràcia entrance of your hotel',
    signature: {
      en: 'Gaudí modernism, the Gothic Quarter and the markets of La Boqueria',
      zh: '高迪的现代主义、歌特区与波盖利亚市场',
    },
  },
  {
    slug: 'madrid',
    name: 'Madrid',
    nameZh: '马德里',
    currency: 'USD',
    timezone: 'Europe/Madrid',
    anchor: { lat: 40.4168, lng: -3.7038 },
    spread: 0.022,
    language: 'Spanish',
    addressStyle: 'Calle de Alcalá, 28014 Madrid',
    meetingStyle: 'your hotel entrance on Calle de Alcalá, or the Retiro gate',
    signature: {
      en: 'the Prado, the Royal Palace and a tapas culture that runs late',
      zh: '普拉多美术馆、王宫与深夜不散的塔帕斯文化',
    },
  },
  {
    slug: 'seville',
    name: 'Seville',
    nameZh: '塞维利亚',
    currency: 'USD',
    timezone: 'Europe/Madrid',
    anchor: { lat: 37.3891, lng: -5.9845 },
    spread: 0.019,
    language: 'Spanish',
    addressStyle: 'Plaza del Triunfo, 41012 Sevilla',
    meetingStyle: 'your hotel patio in the Santa Cruz quarter',
    signature: {
      en: 'Moorish palaces, orange-blossom courtyards and flamenco in the Triana barrio',
      zh: '摩尔式宫殿、橙花庭院与特里亚纳区的弗拉门戈',
    },
  },

  // =============================== Germany =================================
  {
    slug: 'berlin',
    name: 'Berlin',
    nameZh: '柏林',
    currency: 'USD',
    timezone: 'Europe/Berlin',
    anchor: { lat: 52.52, lng: 13.405 },
    spread: 0.026,
    language: 'German',
    addressStyle: 'Unter den Linden, 10117 Berlin',
    meetingStyle: 'the main entrance of your hotel on Unter den Linden',
    signature: {
      en: 'a city built in layers — Prussian, Weimar, modernism and the wall',
      zh: '层层叠叠的城市：普鲁士、魏玛、现代主义与柏林墙',
    },
  },
  {
    slug: 'munich',
    name: 'Munich',
    nameZh: '慕尼黑',
    currency: 'USD',
    timezone: 'Europe/Berlin',
    anchor: { lat: 48.1351, lng: 11.582 },
    spread: 0.021,
    language: 'German',
    addressStyle: 'Marienplatz, 80331 München',
    meetingStyle: 'the Neues Rathaus steps on Marienplatz',
    signature: {
      en: 'Bavarian beer halls, world-class engineering and the Pinakothek',
      zh: '巴伐利亚啤酒馆、世界级工程与皮纳科特美术馆',
    },
  },

  // ============================ Netherlands ===============================
  {
    slug: 'amsterdam',
    name: 'Amsterdam',
    nameZh: '阿姆斯特丹',
    currency: 'USD',
    timezone: 'Europe/Amsterdam',
    anchor: { lat: 52.3676, lng: 4.9041 },
    spread: 0.017,
    language: 'Dutch',
    addressStyle: 'Museumplein, 1071 Amsterdam',
    meetingStyle: 'your canal-side hotel, or the Mauritshuis entrance',
    signature: {
      en: 'canal houses, the Golden Age and a city best seen by bicycle',
      zh: '运河宅邸、黄金时代，以及最适合骑车观看的城市',
    },
  },

  // ============================== Switzerland ==============================
  {
    slug: 'zurich',
    name: 'Zurich',
    nameZh: '苏黎世',
    currency: 'USD',
    timezone: 'Europe/Zurich',
    anchor: { lat: 47.3769, lng: 8.5417 },
    spread: 0.017,
    language: 'German',
    addressStyle: 'Bahnhofstrasse 25, 8001 Zürich',
    meetingStyle: 'the Bahnhofstrasse entrance of your hotel',
    signature: {
      en: 'a lakeside city with a discreet elegance, between lake and Alps',
      zh: '湖山之间一座不事声张而优雅的城市',
    },
  },
  {
    slug: 'interlaken',
    name: 'Interlaken',
    nameZh: '因特拉肯',
    currency: 'USD',
    timezone: 'Europe/Zurich',
    anchor: { lat: 46.6863, lng: 7.8632 },
    spread: 0.02,
    language: 'German & English',
    addressStyle: 'Höheweg 41, 3800 Interlaken',
    meetingStyle: 'the Höheweg station in Interlaken, or your hotel door',
    signature: {
      en: 'two lakes and the gateway to the Bernese Oberland',
      zh: '两湖之间，通往伯尔尼高地的门户',
    },
  },

  // =============================== Austria =================================
  {
    slug: 'vienna',
    name: 'Vienna',
    nameZh: '维也纳',
    currency: 'USD',
    timezone: 'Europe/Vienna',
    anchor: { lat: 48.2082, lng: 16.3738 },
    spread: 0.022,
    language: 'German',
    addressStyle: 'Kärntner Ring 1, 1010 Wien',
    meetingStyle: 'the Kärntner Ring entrance of your hotel',
    signature: {
      en: 'imperial palaces, a concert tradition and the ritual of the coffee house',
      zh: '皇室宫殿、音乐会的传承，以及咖啡馆的仪式感',
    },
  },
  {
    slug: 'salzburg',
    name: 'Salzburg',
    nameZh: '萨尔茨堡',
    currency: 'USD',
    timezone: 'Europe/Vienna',
    anchor: { lat: 47.8095, lng: 13.055 },
    spread: 0.017,
    language: 'German & English',
    addressStyle: 'Getreidegasse 31, 5020 Salzburg',
    meetingStyle: 'the Residenz courtyard in Salzburg’s old town',
    signature: {
      en: 'the Baroque old town, the Mirabell Gardens and the sound of Mozart',
      zh: '巴洛克老城、米拉贝尔花园与莫扎特的声音',
    },
  },

  // =============================== Portugal ================================
  {
    slug: 'lisbon',
    name: 'Lisbon',
    nameZh: '里斯本',
    currency: 'USD',
    timezone: 'Europe/Lisbon',
    anchor: { lat: 38.7223, lng: -9.1393 },
    spread: 0.023,
    language: 'Portuguese',
    addressStyle: 'Praça do Comércio, 1100-148 Lisboa',
    meetingStyle: 'your hotel on Praça do Comércio, or the Arco da Rua Augusta',
    signature: {
      en: 'azulejo façades, fado houses and the light on the Tagus',
      zh: '蓝白瓷砖外墙、法朵小馆与塔霍河上的光',
    },
  },
  {
    slug: 'porto',
    name: 'Porto',
    nameZh: '波尔图',
    currency: 'USD',
    timezone: 'Europe/Lisbon',
    anchor: { lat: 41.1579, lng: -8.6291 },
    spread: 0.019,
    language: 'Portuguese',
    addressStyle: 'Praça da Ribeira, 4050-510 Porto',
    meetingStyle: 'the Ribeira square of your hotel, or São Bento station',
    signature: {
      en: 'port lodges on the Douro, a tiled church and the Atlantic light',
      zh: '杜罗河畔的波特酒庄、瓷砖教堂与大西洋的光',
    },
  },

  // ========================== North America — US ==========================
  {
    slug: 'new-york',
    name: 'New York',
    nameZh: '纽约',
    currency: 'USD',
    timezone: 'America/New_York',
    anchor: { lat: 40.7128, lng: -74.006 },
    spread: 0.024,
    language: 'English',
    addressStyle: '1 World Trade Center, New York, NY 10007',
    meetingStyle: 'the lobby of your Manhattan address, or 72nd Street at the park',
    signature: {
      en: 'a skyline, world-class museums and Broadway within a few blocks of each other',
      zh: '天际线、世界级博物馆与百老汇，触手可及',
    },
  },
  {
    slug: 'los-angeles',
    name: 'Los Angeles',
    nameZh: '洛杉矶',
    currency: 'USD',
    timezone: 'America/Los_Angeles',
    anchor: { lat: 34.0522, lng: -118.2437 },
    spread: 0.03,
    language: 'English',
    addressStyle: '900 S Figueroa St, Los Angeles, CA 90015',
    meetingStyle: 'your hotel lobby on Figueroa Street, or the Beverly Hills meeting point',
    signature: {
      en: 'the Pacific at the end of the street and the studios that shaped film',
      zh: '街道尽头就是太平洋，以及塑造电影的片场',
    },
  },
  {
    slug: 'san-francisco',
    name: 'San Francisco',
    nameZh: '旧金山',
    currency: 'USD',
    timezone: 'America/Los_Angeles',
    anchor: { lat: 37.7749, lng: -122.4194 },
    spread: 0.023,
    language: 'English',
    addressStyle: '1 Ferry Building, San Francisco, CA 94111',
    meetingStyle: 'the Ferry Building clocktower, or your hotel on the Embarcadero',
    signature: {
      en: 'hills, fog that lifts by late afternoon and the bridges of the bay',
      zh: '起伏的山坡、午后散去的雾与海湾上的桥',
    },
  },
  {
    slug: 'miami',
    name: 'Miami',
    nameZh: '迈阿密',
    currency: 'USD',
    timezone: 'America/New_York',
    anchor: { lat: 25.7617, lng: -80.1918 },
    spread: 0.026,
    language: 'English & Spanish',
    addressStyle: '1 Biscayne Blvd, Miami, FL 33131',
    meetingStyle: 'the breezeway of your hotel on Brickell, or the museum porch',
    signature: {
      en: 'Art Deco on Ocean Drive, turquoise water and a Latin rhythm',
      zh: '海洋大道的装饰艺术风格、碧蓝海水与拉丁节奏',
    },
  },
  {
    slug: 'chicago',
    name: 'Chicago',
    nameZh: '芝加哥',
    currency: 'USD',
    timezone: 'America/Chicago',
    anchor: { lat: 41.8781, lng: -87.6298 },
    spread: 0.026,
    language: 'English',
    addressStyle: '233 S Wacker Dr, Chicago, IL 60606',
    meetingStyle: 'the Skydeck lobby on Wacker Drive',
    signature: {
      en: 'a working lakefront, Prairie School architecture and a deep-dish argument',
      zh: '一座仍在运作的湖港、草原学派建筑群，以及关于深盘披萨的争论',
    },
  },
  {
    slug: 'las-vegas',
    name: 'Las Vegas',
    nameZh: '拉斯维加斯',
    currency: 'USD',
    timezone: 'America/Los_Angeles',
    anchor: { lat: 36.1699, lng: -115.1398 },
    spread: 0.024,
    language: 'English',
    addressStyle: '3750 Las Vegas Blvd S, Las Vegas, NV 89158',
    meetingStyle: 'the porte-cochère of your hotel on the Strip',
    signature: {
      en: 'a few hours from the Grand Canyon, Zion and the red rock of the Southwest',
      zh: '距大峡谷、锡安与美国西南红岩仅数小时车程',
    },
  },

  // ========================= North America — Canada =======================
  {
    slug: 'toronto',
    name: 'Toronto',
    nameZh: '多伦多',
    currency: 'USD',
    timezone: 'America/Toronto',
    anchor: { lat: 43.6532, lng: -79.3832 },
    spread: 0.022,
    language: 'English',
    addressStyle: '100 Queens Park, Toronto, ON M5H 2N2',
    meetingStyle: 'the porte-cochère of your downtown Toronto hotel',
    signature: {
      en: 'a lake at the end of every street and neighbourhoods worth getting lost in',
      zh: '每条街道尽头都是湖，而街区本身值得迷路',
    },
  },
  {
    slug: 'vancouver',
    name: 'Vancouver',
    nameZh: '温哥华',
    currency: 'USD',
    timezone: 'America/Vancouver',
    anchor: { lat: 49.2827, lng: -123.1207 },
    spread: 0.024,
    language: 'English',
    addressStyle: '1055 Canada Place, Vancouver, BC V6C 0C3',
    meetingStyle: 'the Canada Place lobby, or your hotel on the waterfront',
    signature: {
      en: 'the Coast Salish mountains behind the skyline and rainforest an hour away',
      zh: '天际线背后的海岸山脉，以及一小时车程外的雨林',
    },
  },

  // ============================= Asia-Pacific =============================
  {
    slug: 'tokyo',
    name: 'Tokyo',
    nameZh: '东京',
    currency: 'USD',
    timezone: 'Asia/Tokyo',
    anchor: { lat: 35.6762, lng: 139.6503 },
    spread: 0.028,
    language: 'Japanese & English',
    addressStyle: '1-1-1 Yurakucho, Chiyoda City, Tokyo 100-0005',
    meetingStyle: 'the hotel reception in Chiyoda, or the agreed meeting box at the station',
    signature: {
      en: 'centuries of ritual sitting beside hyper-modern design',
      zh: '数百年的仪式，与超现代设计并肩而立',
    },
  },
  {
    slug: 'kyoto',
    name: 'Kyoto',
    nameZh: '京都',
    currency: 'USD',
    timezone: 'Asia/Tokyo',
    anchor: { lat: 35.0116, lng: 135.7681 },
    spread: 0.022,
    language: 'Japanese & English',
    addressStyle: '605 Teramachi Marutamachi, Nakagyo Ward, Kyoto 604-8006',
    meetingStyle: 'the machiya entrance in the old city, or your ryokan’s genkan',
    signature: {
      en: 'temple gardens, preserved wooden streets and the restraint of kaiseki',
      zh: '寺庭、保存完好的木构街道与怀石的分寸感',
    },
  },
  {
    slug: 'singapore-city',
    name: 'Singapore',
    nameZh: '新加坡',
    currency: 'USD',
    timezone: 'Asia/Singapore',
    anchor: { lat: 1.3521, lng: 103.8198 },
    spread: 0.02,
    language: 'English',
    addressStyle: '1 Fullerton Road, Singapore 049213',
    meetingStyle: 'the porte-cochère of your hotel, or the concierge desk',
    signature: {
      en: 'a garden city of extraordinary order, with the food cultures of four continents',
      zh: '秩序非凡的花园城市，汇聚四大洲的饮食文化',
    },
  },
  {
    slug: 'sydney',
    name: 'Sydney',
    nameZh: '悉尼',
    currency: 'USD',
    timezone: 'Australia/Sydney',
    anchor: { lat: -33.8688, lng: 151.2093 },
    spread: 0.024,
    language: 'English',
    addressStyle: 'Bennelong Point, Sydney NSW 2000',
    meetingStyle: 'the hotel concierge in the CBD, or Circular Quay Station',
    signature: {
      en: 'a harbour city with an operatic outlook and a coast walk on either side',
      zh: '一座像歌剧院一样的海港城市，两侧都是海岸步道',
    },
  },
  {
    slug: 'melbourne',
    name: 'Melbourne',
    nameZh: '墨尔本',
    currency: 'USD',
    timezone: 'Australia/Melbourne',
    anchor: { lat: -37.8136, lng: 144.9631 },
    spread: 0.026,
    language: 'English',
    addressStyle: 'Federation Square, Melbourne VIC 3000',
    meetingStyle: 'the Flinders Street entrance of your hotel',
    signature: {
      en: 'laneway culture, remarkable coffee and sport taken very seriously',
      zh: '巷弄文化、出色的咖啡，以及被极为认真的对待的运动',
    },
  },
];