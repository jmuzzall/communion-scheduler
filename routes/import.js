// Administrator page for importing communion-scheduler and election-scheduler data, mounted at /admin/import.
const express = require('express');
const multer = require('multer');
const router = express.Router();
const { getDb, transaction, run, openDatabase, rawRows } = require('../db');
const { requireRole } = require('../core/auth');
const { convertCommunion } = require('../core/legacyCommunion');
const { convertElection } = require('../core/legacyElection');
const cal = require('../core/calendar');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

router.use(requireRole('super'));

router.get('/', (req, res) => {
  const result = req.session.importResult || null;
  delete req.session.importResult;
  res.render('hub/import', { page: 'import', result, error: req.query.error || null });
});

function importer(kind) {
  return (req, res) => {
    upload.single('dbfile')(req, res, async err => {
      const fail = msg => res.redirect('/admin/import?error=' + encodeURIComponent(msg));
      if (err) return fail('The file could not be read. Upload the .db file, under 25 MB.');
      if (!req.file) return fail('Choose a .db file to import.');
      let source;
      try {
        source = await openDatabase(req.file.buffer);
        rawRows(source, 'SELECT 1');
      } catch (e) {
        return fail("That file isn't a readable database. Download the .db file from the app's data folder and try again.");
      }
      try {
        const target = await getDb();
        const report = transaction(() => kind === 'communion'
          ? convertCommunion(target, source, rawRows)
          : convertElection(target, source, rawRows, cal.todayIso()));
        run('INSERT INTO audit_log (actor_person_id, action, details) VALUES (?,?,?)',
          [req.person.id, `import_${kind}`, JSON.stringify({ file: req.file.originalname, ...report, peopleCreated: report.peopleCreated.length })]);
        req.session.importResult = { kind, file: req.file.originalname, report };
        res.redirect('/admin/import');
      } catch (e) {
        fail(`Nothing was imported: ${e.message}`);
      } finally {
        source.close();
      }
    });
  };
}

router.post('/communion', importer('communion'));
router.post('/election', importer('election'));

module.exports = router;
