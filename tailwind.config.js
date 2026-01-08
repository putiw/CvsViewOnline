/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./App.{js,jsx,ts,tsx}", "./components/**/*.{js,jsx,ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        background: '#09090b', // dark-zinc-950
        surface: '#18181b', // dark-zinc-900
        primary: '#3b82f6', // blue-500
        text: '#e4e4e7', // zinc-200
        'text-muted': '#a1a1aa', // zinc-400
      }
    },
  },
  plugins: [],
}
