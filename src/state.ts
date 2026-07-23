// @ts-nocheck
// ParkaHub — estado global compartido (paso "state" de la modularizacion).
// Todos los globals que antes vivian como let/var/const en app.ts ahora viven
// en este objeto S. Los inicializadores se copiaron TAL CUAL desde app.ts
// (incluyendo los que leen de localStorage). Cero cambio de comportamiento.

export const S = {
  // --- SCANNER ---
  scanLog: [],
  codeReader: null,
  cameraActive: false,
  lastScanTime: 0,

  // --- ORDENES ---
  manualOrders: [],
  platOrders: [],
  reportData: [],
  filteredMan: [],
  filteredPlat: [],
  filteredRep: [],
  editIdx: -1,

  // --- EXCEL / CONTROL ---
  xlImported: [],
  xlFiltered: [],
  controlEntries: [],
  controlFiltered: [],

  // --- HISTORIAL ---
  historialReportes: JSON.parse(localStorage.getItem('parka_hist')||'[]'),
  hCargas: JSON.parse(localStorage.getItem('parka_hcargas')||'[]'),

  // --- PRECIOS / COSTOS ---
  PC_PRODUCTS: JSON.parse(localStorage.getItem('parka_pc_products')||'[]'),
  PC_PARAMS: JSON.parse(localStorage.getItem('parka_pc_params')||'{}'),
  MX_PLANES: [
    {id:'cuotas6', label:'PREMIUM 6C',   color:'var(--accent)',     feeId:'mx-c6'},
    {id:'cuotas3', label:'PREMIUM 3C',   color:'var(--teal)',       feeId:'mx-c3'},
    {id:'ib',      label:'INTERÉS BAJO', color:'#0369A1',           feeId:'mx-ib'},
    {id:'clasica', label:'CLÁSICA',      color:'var(--text-muted)', feeId:null}
  ],

  // --- TIENDA NUBE ---
  TN_DATA: [],

  // --- TALLES ---
  TALLE_ORDER: ['XXS','XS','S','M','L','XL','2XL','XXL','3XL','XXXL','4XL','XXXXL'],

  // --- VML (ventas por modelo) ---
  VML: null,
  VML_WEEKS: JSON.parse(localStorage.getItem('parka_vml_weeks')||'[]'),
  VML_SORT: {},
  VML_TALLE_ORDER: ['XXS','XS','S','M','L','XL','2XL','XXL','3XL','XXXL','4XL','XXXXL'],
  _vmlFilter: '',
  _vmlWeek: 'all',    // 'all' o índice numérico
  _expanded: {},      // art -> true/false
  _vmlSearch2: '',

  // --- RECLAMOS (ventas con problemas) ---
  reclamos: JSON.parse(localStorage.getItem('parka_reclamos')||'[]'),
  _recFilter: '',   // búsqueda de texto
  _recTipo: '',     // filtro por "Tipo de problema" ('' = todos)

  TOP10_TALLES: [{"art":"W-2038-BLACK","total":633,"talles":[{"t":"M","v":230},{"t":"S","v":165},{"t":"L","v":141},{"t":"XL","v":97}]},{"art":"W-2049-BLACK","total":591,"talles":[{"t":"L","v":168},{"t":"S","v":163},{"t":"M","v":152},{"t":"XL","v":108}]},{"art":"W-2066-BLK","total":579,"talles":[{"t":"S","v":177},{"t":"M","v":170},{"t":"L","v":138},{"t":"XL","v":94}]},{"art":"W-7-BLK","total":578,"talles":[{"t":"M","v":201},{"t":"S","v":176},{"t":"L","v":110},{"t":"XL","v":91}]},{"art":"M-114-BLACK","total":523,"talles":[{"t":"L","v":142},{"t":"XL","v":107},{"t":"M","v":88},{"t":"3XL","v":76},{"t":"XXL","v":63},{"t":"S","v":47}]},{"art":"M-112-BLACK","total":460,"talles":[{"t":"L","v":118},{"t":"XL","v":112},{"t":"XXL","v":93},{"t":"M","v":77},{"t":"S","v":33},{"t":"3XL","v":27}]},{"art":"W-8-BLK","total":413,"talles":[{"t":"S","v":149},{"t":"M","v":104},{"t":"XL","v":87},{"t":"L","v":73}]},{"art":"M-1155-BLACK","total":248,"talles":[{"t":"L","v":79},{"t":"XL","v":54},{"t":"M","v":51},{"t":"XXL","v":45},{"t":"S","v":19}]},{"art":"W-2038-BEIGE","total":228,"talles":[{"t":"M","v":96},{"t":"L","v":76},{"t":"XL","v":41},{"t":"S","v":15}]},{"art":"W-41 BLACK","total":226,"talles":[{"t":"M","v":97},{"t":"L","v":52},{"t":"S","v":51},{"t":"XL","v":26}]}],

  // --- DATA (charts / tabla ventas) ---
  D: {},

  // --- CHARTS / TABLA ---
  CHART_COLORS: ['#2F9E6E','#7FC9A6','#d97706','#dc2626','#0284c7','#2E8B75','#0891b2','#be185d'],
  SC: null,
  SD: 1,
  FQ: '',

  // --- GOOGLE DRIVE ---
  GD: {
    CLIENT_ID: '1024291720346-bj73ksi6ufjgfru6tapvau6qb6gdt7ou.apps.googleusercontent.com', // se lee de cfg-gd-clientid si se agrega, o usar el de abajo
    SCOPES:    'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/spreadsheets',
    token:     null,
    folderId:  localStorage.getItem('parka_gd_folder_id')  || '',
    folderName:localStorage.getItem('parka_gd_folder_name') || '',
  },
  GD_FILE_NAME: 'parka-hub-data.json',
  GD_FILE_ID_CACHE: localStorage.getItem('parka_gd_file_id') || null,
};
