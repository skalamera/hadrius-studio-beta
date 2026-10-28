"""Spanish title/closing card strings (renderer/title_card.py). Imports title_card only (PIL), never
assemble.py or tts.py. Run: .venv/bin/python -m unittest discover -s tests/spanish -p 'test_*.py'"""
import sys, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'renderer'))
import title_card as tc


class CardLocaleTest(unittest.TestCase):
    def test_english_wording_unchanged(self):
        en = tc.card_strings('en')
        self.assertEqual(en['support_badge'], 'N E E D   H E L P ?')
        self.assertEqual(en['support_visit'], 'For additional information, visit our support portal at')
        self.assertEqual(en['support_email'], 'or reach our support team by emailing')
        self.assertEqual(tc.card_strings(None), en)
        self.assertEqual(tc.card_strings('xx'), en)
        self.assertEqual(tc.localize_module('Marketing', 'en'), 'Marketing')
        self.assertEqual(tc.format_title('How to Find a Project ID'), 'How to Find a Project Id')  # existing behaviour

    def test_spanish_wording(self):
        es = tc.card_strings('es')
        self.assertEqual(es['support_badge'], '¿ N E C E S I T A S   A Y U D A ?')
        self.assertIn('portal de soporte', es['support_visit'])
        self.assertIn('equipo de soporte', es['support_email'])
        for word in ('For additional', 'NEED', 'emailing'):
            self.assertNotIn(word, ' '.join(v for v in es.values() if isinstance(v, str)))

    def test_spanish_module_badges(self):
        self.assertEqual(tc.localize_module('Testing program', 'es'), 'Programa de pruebas')
        self.assertEqual(tc.localize_module('People-oversight', 'es'), 'Supervisión de personal')
        self.assertEqual(tc.format_module_badge(tc.localize_module('Communications', 'es')), 'C O M U N I C A C I O N E S')
        self.assertEqual(tc.localize_module('Something else', 'es'), 'Something else')
        self.assertIsNone(tc.localize_module(None, 'es'))

    def test_spanish_title_keeps_its_case(self):
        self.assertEqual(tc.format_localized_title('  Cómo encontrar el ID\n de un proyecto '), 'Cómo encontrar el ID de un proyecto')


if __name__ == '__main__':
    unittest.main()
