import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { ApiError, createIdempotencyKey } from './api';
import {
  getCheckoutBooking,
  getCheckoutPayment,
  holdSecondsRemaining,
  payForBooking,
  type PaymentScenario,
} from './checkout';
import { formatMinorCurrency } from './events';

export function CheckoutPage() {
  const { bookingId = '' } = useParams();
  return <Checkout key={bookingId} bookingId={bookingId} />;
}

function Checkout({ bookingId }: { bookingId: string }) {
  const queryClient = useQueryClient();
  const [now, setNow] = useState(() => performance.now());
  const [scenario, setScenario] = useState<PaymentScenario>('success');
  const demoMode = import.meta.env.VITE_DEMO_MODE === 'true';
  const bookingQuery = useQuery({
    queryKey: ['checkout-booking', bookingId],
    queryFn: () => getCheckoutBooking(bookingId),
    refetchInterval: (query) =>
      query.state.data?.booking.status === 'AWAITING_PAYMENT' ? 5_000 : false,
    retry: false,
  });
  const booking = bookingQuery.data?.booking;
  const paymentQuery = useQuery({
    queryKey: ['checkout-payment', bookingId],
    queryFn: () => getCheckoutPayment(bookingId),
    enabled: Boolean(booking),
    refetchInterval: (query) =>
      booking?.status === 'AWAITING_PAYMENT' ||
      (booking &&
        booking.status !== 'CONFIRMED' &&
        (query.state.data?.status === 'PENDING' ||
          query.state.data?.status === 'SUCCEEDED'))
        ? 5_000
        : false,
    retry: false,
  });
  const payment = paymentQuery.data;
  const charge = useMutation({
    mutationFn: ({ paymentId, key }: { paymentId: string; key: string }) =>
      payForBooking(paymentId, key, demoMode ? scenario : undefined),
    retry: (count, error) => count < 1 && error instanceof TypeError,
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: ['checkout-booking', bookingId],
      });
      void queryClient.invalidateQueries({
        queryKey: ['checkout-payment', bookingId],
      });
    },
  });

  useEffect(() => {
    const timer = window.setInterval(() => setNow(performance.now()), 250);
    return () => window.clearInterval(timer);
  }, []);

  if (bookingQuery.isPending) return <p role="status">Loading checkout...</p>;
  if (bookingQuery.isError) {
    return (
      <section>
        <p role="alert">{bookingQuery.error.message}</p>
        <button
          className="secondary-button mt-4"
          onClick={() => void bookingQuery.refetch()}
          type="button"
        >
          Try again
        </button>
      </section>
    );
  }
  const data = bookingQuery.data;
  const currentBooking = data.booking;
  const seconds = data.serverTime
    ? holdSecondsRemaining(
        currentBooking.expiresAt,
        data.serverTime,
        now - data.receivedAt,
      )
    : 0;
  const expired =
    currentBooking.status === 'EXPIRED' ||
    (currentBooking.status === 'AWAITING_PAYMENT' && seconds === 0);
  const processing =
    charge.isSuccess ||
    Boolean(payment?.scenario) ||
    payment?.status === 'SUCCEEDED';
  const canPay =
    currentBooking.status === 'AWAITING_PAYMENT' &&
    !expired &&
    payment?.status === 'PENDING' &&
    !processing &&
    !charge.isPending;

  return (
    <section className="mx-auto max-w-2xl rounded-xl border border-slate-800 bg-slate-900 p-6 sm:p-8">
      <h1 className="text-3xl font-semibold">Checkout</h1>
      <p className="mt-4 text-lg">
        {formatMinorCurrency(
          currentBooking.totalMinor,
          currentBooking.currency,
        )}
      </p>
      <p className="mt-2 break-words text-sm text-slate-400">
        Seats: {currentBooking.items.map((item) => item.seatId).join(', ')}
      </p>
      {currentBooking.status === 'CONFIRMED' ? (
        <div className="mt-6 text-emerald-300" role="status">
          <p>Your booking is confirmed.</p>
          <Link className="mt-3 inline-block underline" to="/tickets">
            View my tickets
          </Link>
        </div>
      ) : currentBooking.status === 'CANCELLED' || expired ? (
        <div className="mt-6 text-amber-200" role="status">
          <p>
            {expired
              ? 'Your seat hold has expired.'
              : 'Your booking was cancelled.'}
          </p>
          <p className="mt-2">
            {payment?.status === 'REFUNDED'
              ? 'Your payment has been refunded.'
              : 'If a payment succeeds after the hold is lost, it will be refunded automatically.'}
          </p>
        </div>
      ) : (
        <>
          <p
            className="mt-6 text-cyan-300"
            role="timer"
            aria-label="Time left to pay"
          >
            Hold remaining: {Math.floor(seconds / 60)}:
            {String(seconds % 60).padStart(2, '0')}
          </p>
          {paymentQuery.isPending && (
            <p className="mt-4" role="status">
              Loading payment...
            </p>
          )}
          {payment === null && (
            <p className="mt-4" role="status">
              Preparing your payment...
            </p>
          )}
          {processing && (
            <p className="mt-4" role="status">
              Payment submitted. Waiting for booking confirmation...
            </p>
          )}
          {payment?.status === 'FAILED' && (
            <p className="mt-4" role="alert">
              Payment failed. Waiting for booking cancellation.
            </p>
          )}
          {demoMode && (
            <label className="mt-5 block text-sm">
              Demo payment scenario
              <select
                className="form-input"
                value={scenario}
                disabled={!canPay}
                onChange={(event) => {
                  const value = event.target.value;
                  if (
                    value === 'success' ||
                    value === 'fail' ||
                    value === 'slow' ||
                    value === 'duplicate'
                  )
                    setScenario(value);
                }}
              >
                <option value="success">Success</option>
                <option value="fail">Failure</option>
                <option value="slow">Slow success</option>
                <option value="duplicate">Duplicate webhook</option>
              </select>
            </label>
          )}
          <button
            className="primary-button mt-5"
            disabled={!canPay}
            onClick={() => {
              if (payment && canPay)
                charge.mutate({
                  paymentId: payment.id,
                  key: createIdempotencyKey(),
                });
            }}
            type="button"
          >
            {charge.isPending ? 'Submitting payment...' : 'Pay now'}
          </button>
        </>
      )}
      {paymentQuery.isError && (
        <div className="mt-5 text-rose-200" role="alert">
          <p>
            {paymentQuery.error instanceof ApiError &&
            paymentQuery.error.status === 503
              ? 'Payment service is unavailable. No payment has been submitted.'
              : paymentQuery.error.message}
          </p>
          <button
            className="mt-2 underline"
            onClick={() => void paymentQuery.refetch()}
            type="button"
          >
            Retry payment lookup
          </button>
        </div>
      )}
      {charge.isError && (
        <p className="mt-5 text-rose-200" role="alert">
          {charge.error.message}
        </p>
      )}
      <Link
        className="mt-8 inline-block text-cyan-300 underline"
        to={`/events/${currentBooking.eventId}`}
      >
        Back to event
      </Link>
    </section>
  );
}
