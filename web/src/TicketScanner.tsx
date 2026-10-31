import { useEffect, useRef, useState } from 'react';

interface QrDetector {
  detect: (source: HTMLVideoElement) => Promise<{ rawValue: string }[]>;
}

function getQrDetector(): QrDetector {
  if (
    !('BarcodeDetector' in window) ||
    typeof window.BarcodeDetector !== 'function'
  ) {
    throw new Error(
      'Camera QR scanning is not supported in this browser. Paste the ticket token below.',
    );
  }
  const Detector = window.BarcodeDetector as new (options: {
    formats: string[];
  }) => QrDetector;
  return new Detector({ formats: ['qr_code'] });
}

export function TicketScanner({
  disabled,
  onScan,
}: {
  disabled: boolean;
  onScan: (value: string) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!scanning || disabled) return;
    let stopped = false;
    let stream: MediaStream | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function stopStream() {
      stream?.getTracks().forEach((track) => track.stop());
      if (video.current && video.current.srcObject === stream)
        video.current.srcObject = null;
    }

    async function start() {
      try {
        const detector = getQrDetector();
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });
        if (stopped || !video.current) {
          stopStream();
          return;
        }
        video.current.srcObject = stream;
        await video.current.play();
        async function detect() {
          if (stopped || !video.current) return;
          try {
            const results = await detector.detect(video.current);
            if (stopped) return;
            const token = results[0]?.rawValue;
            if (token) {
              setScanning(false);
              stopStream();
              onScan(token);
              return;
            }
            timer = setTimeout(() => void detect(), 300);
          } catch (cause: unknown) {
            fail(cause);
          }
        }
        if (!stopped) void detect();
      } catch (cause: unknown) {
        fail(cause);
      }
    }

    function fail(cause: unknown) {
      stopStream();
      if (stopped) return;
      setError(
        cause instanceof Error
          ? cause.message
          : 'Camera scanning failed. Paste the token below.',
      );
      setScanning(false);
    }

    void start();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      stopStream();
    };
  }, [scanning, disabled, onScan]);

  return (
    <div className="mt-6">
      <button
        className="secondary-button"
        disabled={disabled}
        onClick={() => {
          setError(undefined);
          setScanning((current) => !current);
        }}
        type="button"
      >
        {scanning ? 'Stop camera' : 'Scan QR with camera'}
      </button>
      {scanning && (
        <video
          className="mt-4 aspect-video w-full rounded-2xl border border-slate-800 bg-slate-950 object-cover"
          ref={video}
          muted
          playsInline
          aria-label="Ticket scanner camera preview"
        />
      )}
      {error && (
        <p className="mt-3 text-amber-200" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
