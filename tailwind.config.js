/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: { sans: ['"Inter Tight"', 'ui-sans-serif', 'system-ui', 'sans-serif'] },
      colors: { primary: '#2337EE' },
    },
  },
  plugins: [],
};
