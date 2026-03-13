/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./client/src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        phoenix: {
          50: "#fef3e2",
          100: "#fde4b9",
          200: "#fcd48c",
          300: "#fbc35f",
          400: "#fab63d",
          500: "#f9a825",
          600: "#f59021",
          700: "#ef7a1c",
          800: "#e96518",
          900: "#df4011",
        },
        sniper: {
          50: "#e8eaf6",
          100: "#c5cae9",
          200: "#9fa8da",
          300: "#7986cb",
          400: "#5c6bc0",
          500: "#3f51b5",
          600: "#3949ab",
          700: "#303f9f",
          800: "#283593",
          900: "#1a237e",
        },
        surface: {
          50: "#f8fafc",
          100: "#f1f5f9",
          200: "#e2e8f0",
          700: "#1e293b",
          800: "#0f172a",
          900: "#020617",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "Fira Code", "monospace"],
      },
      animation: {
        "pulse-glow": "pulse-glow 2s ease-in-out infinite",
        "slide-up": "slide-up 0.3s ease-out",
        "fade-in": "fade-in 0.4s ease-out",
      },
      keyframes: {
        "pulse-glow": {
          "0%, 100%": { boxShadow: "0 0 5px rgba(249,168,37,0.3)" },
          "50%": { boxShadow: "0 0 20px rgba(249,168,37,0.6)" },
        },
        "slide-up": {
          "0%": { transform: "translateY(10px)", opacity: "0" },
          "100%": { transform: "translateY(0)", opacity: "1" },
        },
        "fade-in": {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
      },
    },
  },
  plugins: [],
};
