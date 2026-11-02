"""One offline ASR process, using the unchanged upstream SpeechRecognizer."""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys


def deny_network(event, _args):
    if event in {'socket.connect', 'socket.getaddrinfo', 'socket.sendto'}:
        raise PermissionError('workbench_offline_worker')


def transcribe(request):
    os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1', DO_NOT_TRACK='1')
    sys.addaudithook(deny_network)
    from backend.services import whisper_runtime
    from backend.services.whisper_model_manager import get_model_manager
    if not whisper_runtime.is_installed() or get_model_manager().get_local_model_path('base') is None:
        raise RuntimeError('asr_not_ready')
    whisper_runtime.ensure_on_path()
    import onnxruntime
    onnxruntime.disable_telemetry_events()
    from backend.utils.speech_recognizer import SpeechRecognizer, SpeechRecognitionConfig
    from backend.utils.transcription_progress import reporting
    progress_path = Path(request['progress'])
    def report(fraction):
        pending = progress_path.with_suffix('.pending')
        pending.write_text(json.dumps({'progress': fraction}), encoding='utf-8')
        pending.replace(progress_path)
    recognizer = SpeechRecognizer(SpeechRecognitionConfig(model='base', language='auto', enable_fallback=False))
    with reporting(report):
        recognizer._generate_subtitle_whisper_local(Path(request['source']), Path(request['output']), recognizer.config)


def main():
    request = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    try:
        transcribe(request)
        Path(request['result']).write_text(json.dumps({'status': 'completed'}), encoding='utf-8')
    except Exception:
        # The private per-job log is local only; retain diagnostics for missing bundled dependencies.
        import traceback
        traceback.print_exc()
        # No user paths, transcript or exception bodies enter the task API.
        Path(request['result']).write_text(json.dumps({'status': 'failed', 'error': 'transcription_failed'}), encoding='utf-8')
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
