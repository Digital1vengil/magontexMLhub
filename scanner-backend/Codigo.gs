// PARKA Despacho - Google Apps Script Backend v3 (con Flex/Colecta)
// ================================================
// PASOS:
// 1. Abre Google Sheets -> Extensiones -> Apps Script
// 2. Borra TODO el codigo y pega este archivo
// 3. Guarda con Ctrl+S
// 4. Selecciona la funcion testPing -> Ejecutar -> Autorizar permisos
// 5. Implementar -> Nueva implementacion -> Aplicacion web
//    Ejecutar como: Yo | Acceso: Cualquier persona
// 6. Copia la URL /exec y pegala en la app PARKA

var MAX_HISTORY = 50;
var FOLDER_NAME = 'PARKA Despacho';
var TIPO_FLEX = 'flex';
var TIPO_COLECTA = 'colecta';
var TIPO_TIENDANUBE = 'tiendanube';

// GET
function doGet(e) {
  var params = e && e.parameter ? e.parameter : {};
  var action = params.action || '';
  var tipo = params.tipo || TIPO_FLEX;  // default a flex
  var result;

  try {
    if (action === 'ping') {
      result = { ok: true, ts: new Date().toISOString(), version: 3 };

    } else if (action === 'beginDay') {
      result = beginDay(tipo);

    } else if (action === 'session') {
      result = readSession();

    } else if (action === 'history') {
      result = readHistory();

    } else if (action === 'listFiles') {
      result = listDriveFiles(tipo);

    } else if (action === 'getFile') {
      result = getDriveFile(params.fileId);

    } else {
      result = { error: 'Accion desconocida: ' + action };
    }
  } catch (ex) {
    result = { error: String(ex), stack: ex.stack };
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// POST
function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (ex) {
    return jsonOut({ error: 'JSON invalido' });
  }

  var action = body.action || '';
  var tipo = body.tipo || TIPO_FLEX;
  try {
    if (action === 'saveSession') {
      writeSession(body.data);

    } else if (action === 'clearSession') {
      var cur = readSession();
      if (cur) appendHistory(Object.assign({}, cur, { _archivedAt: new Date().toISOString() }));
      clearSession();

    } else if (action === 'clearHistory') {
      clearHistory();

    } else if (action === 'saveReport') {
      saveReportToFinDelDia(body.data, tipo);

    } else if (action === 'procesarExcel') {
      var result = procesarYGuardarExcel(body.data, tipo);
      return jsonOut(result);

    } else {
      return jsonOut({ error: 'Accion desconocida: ' + action });
    }
  } catch (ex) {
    return jsonOut({ error: String(ex) });
  }

  return jsonOut({ ok: true });
}

// procesarYGuardarExcel: recibe { datos: [...], fecha: 'YYYY-MM-DD' } y tipo (flex/colecta)
// Crea un Google Sheet temporal, lo exporta a .xlsx, lo guarda en Drive y borra el Sheet.
function procesarYGuardarExcel(body, tipo) {
  if (!body || !body.datos || body.datos.length === 0) {
    return { ok: false, error: 'Sin datos para guardar' };
  }

  var datos = body.datos;
  var fecha = body.fecha || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');

  // Incluir el tipo en el nombre del archivo
  var tipoCapital = tipo === TIPO_FLEX ? 'Flex' : (tipo === TIPO_TIENDANUBE ? 'TiendaNube' : 'Colecta');
  var nombre = 'Despacho_' + tipoCapital + '_' + fecha;

  // 1. Crear Google Sheet temporal
  var ss = SpreadsheetApp.create(nombre);
  var sh = ss.getActiveSheet();

  // 2. Encabezados
  var headers = ['Paquetes Despachados', 'Numero de Etiqueta', 'ID de Venta', 'Nombre de la Persona', 'Cantidad de Prendas', 'SKU Despachados', 'Estado'];
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);

  // 3. Datos
  var rows = datos.map(function(p) {
          return [
            p['Paquetes Despachados'] || '',
            p['Numero de Etiqueta']   || '',
            p['ID de Venta']          || '',
            p['Nombre de la Persona'] || '',
            p['Cantidad de Prendas']  || '',
            p['SKU Despachados']      || '',
            p['Estado']               || ''
          ];
        });
  sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
  SpreadsheetApp.flush();

  // 4. Exportar a .xlsx via URL
  var fileId  = ss.getId();
  var url     = 'https://docs.google.com/spreadsheets/d/' + fileId + '/export?format=xlsx';
  var token   = ScriptApp.getOAuthToken();
  var resp    = UrlFetchApp.fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });

  var time    = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'HH-mm');
  var xlsName = nombre + '_' + time + '.xlsx';
  var blob    = resp.getBlob().setName(xlsName);

  // 5. Guardar .xlsx en la subcarpeta "fin del dia" dentro de la carpeta tipo/fecha
  var finFolder = getFinDelDiaFolder(tipo);
  var xlsFile   = finFolder.createFile(blob);

  // 6. Eliminar Sheet temporal
  DriveApp.getFileById(fileId).setTrashed(true);

  return {
    ok:       true,
    fileName: xlsName,
    fileUrl:  xlsFile.getUrl(),
    count:    datos.length,
    tipo:     tipo
  };
}

// Drive - Estructura de carpetas mejorada
function getRootFolder() {
  var it = DriveApp.getFoldersByName(FOLDER_NAME);
  return it.hasNext() ? it.next() : DriveApp.createFolder(FOLDER_NAME);
}

function getFlexFolder() {
  var root = getRootFolder();
  var it = root.getFoldersByName(TIPO_FLEX);
  return it.hasNext() ? it.next() : root.createFolder(TIPO_FLEX);
}

function getColectaFolder() {
  var root = getRootFolder();
  var it = root.getFoldersByName(TIPO_COLECTA);
  return it.hasNext() ? it.next() : root.createFolder(TIPO_COLECTA);
}

function getTiendaNubeFolder() {
  var root = getRootFolder();
  var it = root.getFoldersByName('TiendaNube');
  return it.hasNext() ? it.next() : root.createFolder('TiendaNube');
}

function getTipoBaseFolder(tipo) {
  if (tipo === TIPO_TIENDANUBE) return getTiendaNubeFolder();
  return tipo === TIPO_FLEX ? getFlexFolder() : getColectaFolder();
}

function beginDay(tipo) {
  var folder = getTodayFolder(tipo);
  return { ok: true, folderName: folder.getName(), folderId: folder.getId(), tipo: tipo };
}

function getTodayFolder(tipo) {
  var tz    = Session.getScriptTimeZone();
  var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var tipoBase = getTipoBaseFolder(tipo);
  var it = tipoBase.getFoldersByName(today);
  return it.hasNext() ? it.next() : tipoBase.createFolder(today);
}

function getFinDelDiaFolder(tipo) {
  var todayFolder = getTodayFolder(tipo);
  var it = todayFolder.getFoldersByName('fin del dia');
  return it.hasNext() ? it.next() : todayFolder.createFolder('fin del dia');
}

function saveReportToFinDelDia(data, tipo) {
  if (!data || !data.fileName || !data.content) return;
  var finFolder = getFinDelDiaFolder(tipo);
  var bytes = Utilities.base64Decode(data.content);
  var blob = Utilities.newBlob(
    bytes,
    data.mimeType || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    data.fileName
  );
  finFolder.createFile(blob);
}

function getFilesInFolder(folder) {
  var files = [];
  var it = folder.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    var name = f.getName();
    var ext = name.split('.').pop().toLowerCase();
    if (['txt','csv','xls','xlsx','zpl'].indexOf(ext) !== -1) {
      files.push({
        id: f.getId(),
        name: name,
        size: f.getSize(),
        modifiedAt: f.getLastUpdated().toISOString()
      });
    }
  }
  return files.sort(function(a, b) { return b.modifiedAt.localeCompare(a.modifiedAt); });
}

function listDriveFiles(tipo) {
  var tipoBase = getTipoBaseFolder(tipo);
  getTodayFolder(tipo);

  // Solo la carpeta del tipo elegido; omite carpetas vacías y unifica duplicados por fecha.
  var byName = {};
  var order = [];
  var fit = tipoBase.getFolders();
  while (fit.hasNext()) {
    var f = fit.next();
    var name = f.getName();
    var files = getFilesInFolder(f);
    if (files.length === 0) continue;
    if (!byName[name]) { byName[name] = { date: name, folderId: f.getId(), files: files }; order.push(name); }
    else { byName[name].files = byName[name].files.concat(files); }
  }
  var groups = order.sort(function(a, b) { return b.localeCompare(a); }).map(function(n) { return byName[n]; });

  var rootFiles = getFilesInFolder(tipoBase);
  if (rootFiles.length > 0) {
    groups.push({ date: 'Sin fecha', folderId: tipoBase.getId(), files: rootFiles });
  }

  return {
    rootFolderUrl: 'https://drive.google.com/drive/folders/' + tipoBase.getId(),
    groups: groups,
    tipo: tipo
  };
}

// Tienda Nube: escanea TODO el arbol de PARKA Despacho buscando csv/xls/xlsx
function getTNFiles(folder) {
  var files = [];
  var it = folder.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    var name = f.getName();
    var ext = name.split('.').pop().toLowerCase();
    if (['csv','xls','xlsx'].indexOf(ext) !== -1) {
      files.push({ id: f.getId(), name: name, size: f.getSize(), modifiedAt: f.getLastUpdated().toISOString() });
    }
  }
  return files.sort(function(a, b) { return b.modifiedAt.localeCompare(a.modifiedAt); });
}

function collectTNGroups(folder, groups, depth) {
  if (depth > 4) return;
  var files = getTNFiles(folder);
  if (files.length > 0) groups.push({ date: folder.getName(), folderId: folder.getId(), files: files });
  var it = folder.getFolders();
  while (it.hasNext()) { collectTNGroups(it.next(), groups, depth + 1); }
}

function listTiendaNubeFiles() {
  var root = getRootFolder();
  getTodayFolder(TIPO_TIENDANUBE); // asegura que exista PARKA Despacho/TiendaNube/HOY
  var groups = [];
  collectTNGroups(root, groups, 0);
  groups.sort(function(a, b) { return b.date.localeCompare(a.date); });
  return {
    rootFolderUrl: 'https://drive.google.com/drive/folders/' + getTiendaNubeFolder().getId(),
    groups: groups,
    tipo: TIPO_TIENDANUBE
  };
}

function getDriveFile(fileId) {
  if (!fileId) return { error: 'fileId requerido' };
  var f = DriveApp.getFileById(fileId);
  var name = f.getName();
  var ext = name.split('.').pop().toLowerCase();
  if (ext === 'txt' || ext === 'csv') {
    return { type: 'text', name: name, content: f.getBlob().getDataAsString('UTF-8') };
  }
  return {
    type: 'base64',
    name: name,
    mimeType: f.getMimeType(),
    content: Utilities.base64Encode(f.getBlob().getBytes())
  };
}

// Session
function getSheet(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function readSession() {
  var val = getSheet('Session').getRange('A2').getValue();
  if (!val) return null;
  try { return JSON.parse(val); } catch (e) { return null; }
}

function writeSession(data) {
  var sh = getSheet('Session');
  sh.getRange('A1').setValue('session_json');
  sh.getRange('A2').setValue(JSON.stringify(data));
}

function clearSession() {
  getSheet('Session').getRange('A2').clearContent();
}

// History
function readHistory() {
  var sh = getSheet('History');
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, 1).getValues()
    .map(function(r) { try { return JSON.parse(r[0]); } catch (e) { return null; } })
    .filter(Boolean);
}

function appendHistory(entry) {
  var sh = getSheet('History');
  if (sh.getLastRow() < 1) sh.getRange('A1').setValue('session_json');
  sh.insertRowAfter(1);
  sh.getRange('A2').setValue(JSON.stringify(entry));
  var total = sh.getLastRow() - 1;
  if (total > MAX_HISTORY) sh.deleteRows(MAX_HISTORY + 2, total - MAX_HISTORY);
}

function clearHistory() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('History');
  if (!sh || sh.getLastRow() < 2) return;
  sh.deleteRows(2, sh.getLastRow() - 1);
}

function jsonOut(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// Test - ejecutar manualmente para autorizar permisos
function testPing() {
  Logger.log('OK: ' + JSON.stringify({ ok: true, ts: new Date().toISOString() }));
}
