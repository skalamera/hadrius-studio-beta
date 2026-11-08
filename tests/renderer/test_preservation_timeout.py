"""Full decoded-media verification must not inherit a 60s metadata timeout."""
import subprocess
import unittest
from unittest.mock import patch

from renderer import preservation


class PreservationTimeoutTests(unittest.TestCase):
    def test_shared_runner_gives_full_video_checks_a_bounded_media_budget(self):
        with patch.object(preservation.subprocess, 'check_output', return_value=b'checked') as invoke:
            self.assertEqual(preservation.run('ffmpeg', '-version'), b'checked')
        self.assertEqual(invoke.call_args.kwargs['timeout'], 600)
        self.assertEqual(invoke.call_args.kwargs['stderr'], subprocess.PIPE)

    def test_explicit_timeout_propagates_and_is_not_treated_as_verified(self):
        error = subprocess.TimeoutExpired(['ffmpeg'], 1)
        with patch.object(preservation.subprocess, 'check_output', side_effect=error) as invoke:
            with self.assertRaises(subprocess.TimeoutExpired):
                preservation.run('ffmpeg', timeout=1)
        self.assertEqual(invoke.call_args.kwargs['timeout'], 1)

    def test_frames_still_requests_all_frames_and_rejects_empty_evidence(self):
        with patch.object(preservation, 'run', return_value=b'#tb 0: 1/30\n') as invoke:
            with self.assertRaisesRegex(ValueError, 'missing_frame_evidence'):
                preservation.frames('long-video.mp4')
        args = invoke.call_args.args
        self.assertIn('framehash', args)
        self.assertNotIn('-frames:v', args)
        self.assertNotIn('-ss', args)
        self.assertNotIn('-t', args)


if __name__ == '__main__':
    unittest.main()
