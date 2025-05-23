import React, { useState, useEffect, useCallback, useRef } from "react";
import axios from "axios";
import QRCode from "react-qr-code";
import "./App.css";

const LNBITS_API_PAYMENTS = "https://demo.lnbits.com/api/v1/payments";
const LNBITS_API_WITHDRAW = "https://demo.lnbits.com/withdraw/api/v1/links";
const LNBITS_API_WALLET = "https://demo.lnbits.com/api/v1/wallet";
const FEE_BUFFER_SATS = 10;
const INVOICE_AMOUNT = 100;
const REFRESH_WITHDRAWAL_INTERVAL = 5000;
const REFRESH_POT_INTERVAL = 10000;
const MAX_PAYMENT_ATTEMPTS = 5;
const INITIAL_BACKOFF_MS = 3000;
const ADMIN_KEY = import.meta.env.VITE_ADMIN_KEY;

function App() {
  const [guess, setGuess] = useState(null);
  const [invoice, setInvoice] = useState(null);
  const [paymentHash, setPaymentHash] = useState(null);
  const [paid, setPaid] = useState(false);
  const [pot, setPot] = useState(0);
  const [result, setResult] = useState(null);
  const [rolling, setRolling] = useState(false);
  const [lnurl, setLnurl] = useState(null);
  const [withdrawId, setWithdrawId] = useState(null);
  const [awaitingPayout, setAwaitingPayout] = useState(false);
  const [errorMessage, setErrorMessage] = useState(null);

  // Refs for stable callbacks
  const rollingRef = useRef(false);

  // Fetch pot and return the latest balance (stable)
  const fetchPotFromWallet = useCallback(async () => {
    try {
      const res = await axios.get(LNBITS_API_WALLET, {
        headers: { "X-Api-Key": ADMIN_KEY, "Content-Type": "application/json" },
      });
      const sats = Math.floor(res.data.balance / 1000);
      setPot(sats);
      return sats;
    } catch (err) {
      console.error("Failed to fetch wallet balance:", err);
      setErrorMessage("Unable to fetch pot balance. Please try again later.");
      return 0;
    }
  }, []);

  const resetGameState = () => {
    setGuess(null);
    setInvoice(null);
    setPaymentHash(null);
    setPaid(false);
    setResult(null);
    setRolling(false);
    setLnurl(null);
    setWithdrawId(null);
    setAwaitingPayout(false);
    setErrorMessage(null);
  };

  const createInvoice = useCallback(async () => {
    try {
      const res = await axios.post(
        LNBITS_API_PAYMENTS,
        { out: false, amount: INVOICE_AMOUNT, memo: "Pay to Roll Dice Game" },
        {
          headers: {
            "X-Api-Key": ADMIN_KEY,
            "Content-Type": "application/json",
          },
        },
      );
      setInvoice(res.data.bolt11);
      setPaymentHash(res.data.payment_hash);
    } catch (err) {
      console.error("Invoice creation failed:", err);
      setErrorMessage("Failed to create payment invoice. Please try again.");
    }
  }, []);

  const createLnurlWithdraw = useCallback(async (withdrawable) => {
    setErrorMessage(null);
    if (withdrawable <= 0) {
      setErrorMessage("Pot too low to cover withdrawal fee.");
      return;
    }
    try {
      const res = await axios.post(
        LNBITS_API_WITHDRAW,
        {
          title: "Dice Game Winnings",
          min_withdrawable: withdrawable,
          max_withdrawable: withdrawable,
          uses: 1,
          wait_time: 1,
          is_unique: true,
        },
        {
          headers: {
            "X-Api-Key": ADMIN_KEY,
            "Content-Type": "application/json",
          },
        },
      );
      setLnurl(res.data.lnurl);
      setWithdrawId(res.data.id);
    } catch (err) {
      console.error("Failed to create LNURL-withdraw:", err);
      setErrorMessage(
        "Unable to create withdrawal link. Please try again later.",
      );
    }
  }, []);

  const rollDice = useCallback(async () => {
    if (rollingRef.current) return;
    rollingRef.current = true;
    setRolling(true);

    const diceRoll = Math.floor(Math.random() * 6) + 1;

    if (diceRoll === guess) {
      setResult("🎉 Correct! You won!");
      setAwaitingPayout(true);
      const latestPot = await fetchPotFromWallet();
      await createLnurlWithdraw(latestPot - FEE_BUFFER_SATS);
    } else {
      await fetchPotFromWallet();
      setResult(
        <span>
          ❌ Wrong! It was {diceRoll}.{" "}
          <button
            className="text-blue-600 underline ml-1"
            onClick={resetGameState}
          >
            Try again.
          </button>
        </span>,
      );
    }

    setRolling(false);
    rollingRef.current = false;
  }, [guess, createLnurlWithdraw, fetchPotFromWallet]);

  const checkPayment = useCallback(() => {
    if (!paymentHash) return;
    let cancelled = false;
    let attempts = 0;

    const verify = async () => {
      try {
        const res = await axios.get(`${LNBITS_API_PAYMENTS}/${paymentHash}`, {
          headers: {
            "X-Api-Key": ADMIN_KEY,
            "Content-Type": "application/json",
          },
        });
        if (cancelled) return;
        if (res.data.paid) {
          setPaid(true);
          rollDice();
          return;
        }
        attempts += 1;
        if (attempts >= MAX_PAYMENT_ATTEMPTS) {
          setErrorMessage(
            "Payment is taking longer than expected. Please check your wallet.",
          );
          return;
        }
        const backoff = Math.min(
          INITIAL_BACKOFF_MS * 2 ** (attempts - 1),
          30000,
        );
        setTimeout(verify, backoff);
      } catch (err) {
        console.error("Payment check failed:", err);
        setErrorMessage("Error checking payment status. Please refresh.");
      }
    };

    verify();
    return () => {
      cancelled = true;
    };
  }, [paymentHash, rollDice]);

  const handleGuess = useCallback(
    async (num) => {
      setGuess(num);
      setResult(null);
      setPaid(false);
      setLnurl(null);
      setWithdrawId(null);
      setAwaitingPayout(false);
      setErrorMessage(null);
      await createInvoice();
    },
    [createInvoice],
  );

  // Trigger payment check and initial pot fetch
  useEffect(() => {
    if (invoice && paymentHash) checkPayment();
    fetchPotFromWallet();
  }, [invoice, paymentHash, checkPayment, fetchPotFromWallet]);

  // Poll withdrawal status
  useEffect(() => {
    if (!awaitingPayout || !withdrawId) return;
    const interval = setInterval(async () => {
      try {
        const res = await axios.get(`${LNBITS_API_WITHDRAW}/${withdrawId}`, {
          headers: {
            "X-Api-Key": ADMIN_KEY,
            "Content-Type": "application/json",
          },
        });
        if (res.data.used) {
          console.log("Withdrawal claimed!");
          await fetchPotFromWallet();
          resetGameState();
        }
      } catch (err) {
        console.error("Failed to check withdrawal status:", err);
        setErrorMessage("Error checking withdrawal. Please try again later.");
      }
    }, REFRESH_WITHDRAWAL_INTERVAL);
    return () => clearInterval(interval);
  }, [awaitingPayout, withdrawId, fetchPotFromWallet]);

  // Regular pot refresh
  useEffect(() => {
    const interval = setInterval(fetchPotFromWallet, REFRESH_POT_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchPotFromWallet]);

  return (
    <div className="app-container">
      <header className="header">
        <h1 className="text-2xl font-bold mb-4">🎲 Pay to Roll Dice Game</h1>
      </header>

      <main className="main-content">
        <p className="mb-4">
          Current pot: {Math.max(pot - FEE_BUFFER_SATS, 0)} sats
        </p>

        {errorMessage && <p className="mb-4 text-red-600">{errorMessage}</p>}

        {!invoice && (
          <div className="grid grid-cols-3 gap-2">
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <button
                key={n}
                className="bg-blue-500 text-white py-2 rounded"
                onClick={() => handleGuess(n)}
                disabled={rolling || awaitingPayout}
              >
                {n}
              </button>
            ))}
          </div>
        )}

        {invoice && !paid && (
          <div className="mt-4 text-center border p-4">
            <p className="mt-2 font-semibold">You selected: {guess}</p>
            <p>Scan or copy invoice to pay:</p>
            <QRCode value={invoice} size={180} className="mx-auto my-2" />
            <textarea readOnly className="w-full p-2 border" value={invoice} />
            <p className="text-sm mt-2">Waiting for payment...</p>
            <button
              className="mt-4 bg-red-500 text-white px-4 py-2 rounded"
              onClick={resetGameState}
            >
              Cancel
            </button>
          </div>
        )}

        {paid && result && <div className="mt-4 text-lg">{result}</div>}

        {awaitingPayout && lnurl && (
          <div className="mt-4 text-center">
            <p>
              🎉 You won! Scan the LNURL-withdraw QR code to claim your sats:
            </p>
            <div className="my-4">
              <QRCode value={lnurl} size={180} className="mx-auto" />
            </div>
          </div>
        )}

        {rolling && (
          <div className="mt-4 text-lg animate-pulse">Rolling dice...</div>
        )}
      </main>

      <footer className="footer">
        <a
          href="https://github.com/shmoula/LN-dice-game"
          target="_blank"
          rel="noopener noreferrer"
          className="underline"
        >
          View this project on GitHub
        </a>
      </footer>
    </div>
  );
}

export default App;
