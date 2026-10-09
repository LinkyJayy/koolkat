// Kat Kart's maps, shared by the game and the server (which checks the host's
// pick). Each track is a closed loop through its points, smoothed into a
// curve. Points are drawn on a 1024 × 1024 grid and scaled up to the map,
// which is KART_MAP_SIZE world units across.

export const KART_MAP_SIZE = 2048;
export const KART_MAP_SCALE = KART_MAP_SIZE / 1024;

export const KART_MAPS = [
  {
    id: 'kool-kircuit',
    name: 'Kool Kircuit',
    emoji: '🏁',
    song: 'natho-town', // each map has its own song (played unless you pick another)
    points: [
      [512, 900], [700, 905], [860, 860], [930, 740], [900, 610], [790, 560], [690, 520], [650, 430],
      [700, 330], [820, 280], [890, 190], [830, 100], [680, 85], [520, 120], [400, 210], [300, 190],
      [190, 130], [105, 200], [110, 340], [200, 430], [320, 480], [380, 580], [330, 690], [210, 730],
      [150, 820], [230, 895], [370, 905],
    ],
    colors: { ground: ['#3da447', '#46b351'], curbEdge: '#e7d7a4', curbA: '#ffffff', curbB: '#e5172f', road: '#5d5f66', lane: 'rgba(255,255,255,0.55)' },
  },
  {
    id: 'nighttime',
    name: 'Nighttime',
    emoji: '🌙',
    song: 'crystal-cavern',
    points: [
      [512, 900], [760, 905], [900, 850], [930, 720], [860, 640], [700, 630], [600, 560], [620, 460],
      [760, 430], [900, 380], [920, 250], [840, 140], [680, 110], [560, 170], [500, 280], [420, 330],
      [300, 300], [230, 190], [120, 170], [90, 300], [130, 450], [180, 560], [120, 680], [110, 820],
      [230, 900], [370, 905],
    ],
    colors: { ground: ['#14281f', '#183024'], curbEdge: '#2a2d3a', curbA: '#ffd23f', curbB: '#202330', road: '#33353f', lane: 'rgba(255,210,63,0.7)' },
  },
  {
    id: 'crystal-cavern',
    name: 'Crystal Cavern',
    emoji: '💎',
    song: 'crystal-cavern',
    points: [
      [512, 920], [700, 910], [820, 840], [800, 740], [680, 700], [600, 620], [680, 540], [840, 560],
      [930, 480], [920, 330], [820, 260], [700, 300], [620, 230], [650, 120], [520, 80], [400, 120],
      [380, 230], [290, 300], [160, 250], [90, 340], [140, 450], [280, 470], [330, 560], [240, 640],
      [110, 680], [90, 820], [200, 910], [360, 925],
    ],
    colors: { ground: ['#251a38', '#2c2042'], curbEdge: '#150f22', curbA: '#5ef2ff', curbB: '#ff5ed8', road: '#3d3852', lane: 'rgba(160,240,255,0.6)' },
  },
  {
    id: 'kingdom',
    name: 'Kingdom',
    emoji: '🏰', // inside the castle: the throne room
    song: 'kingdom-dominance',
    points: [
      [512, 900], [720, 900], [880, 840], [940, 700], [930, 520], [860, 420], [760, 440], [700, 540],
      [620, 560], [560, 480], [600, 360], [720, 300], [860, 240], [880, 130], [760, 80], [560, 80],
      [380, 100], [260, 160], [300, 260], [420, 300], [440, 400], [340, 450], [200, 400], [100, 450],
      [90, 600], [160, 720], [120, 840], [250, 905], [380, 905],
    ],
    colors: { ground: ['#8f8a99', '#98939f'], curbEdge: '#6b4e0e', curbA: '#e8c040', curbB: '#b8891a', road: '#a3142a', lane: 'rgba(0,0,0,0)' },
  },
  {
    id: 'gold-mine',
    name: 'Gold Mine',
    emoji: '⛏️',
    song: 'gold-mine',
    points: [
      [512, 910], [680, 905], [770, 830], [720, 740], [600, 710], [540, 630], [600, 550], [740, 570],
      [870, 620], [945, 520], [925, 390], [810, 350], [730, 270], [790, 170], [870, 100], [740, 70],
      [560, 90], [470, 180], [490, 290], [420, 380], [300, 350], [250, 240], [300, 140], [200, 80],
      [90, 150], [80, 320], [170, 420], [280, 500], [300, 620], [200, 700], [90, 760], [110, 880],
      [260, 915], [380, 915],
    ],
    colors: { ground: ['#8a6235', '#94693a'], curbEdge: '#4a3018', curbA: '#c8914a', curbB: '#6b4422', road: '#6e4c2c', lane: 'rgba(0,0,0,0)' },
  },
];

export const KART_MAP_IDS = KART_MAPS.map((m) => m.id);
export const kartMap = (id) => KART_MAPS.find((m) => m.id === id) ?? KART_MAPS[0];
