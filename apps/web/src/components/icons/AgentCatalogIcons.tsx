import { cn } from "~/lib/utils";
import { type Icon } from "./iconTypes";

export const ANTIGRAVITY_ICON_DATA_URL =
  "data:image/png;base64,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";

export const Gemini: Icon = (props) => (
  <svg {...props} viewBox="0 0 296 298" fill="none">
    <mask
      id="gemini__a"
      width="296"
      height="298"
      x="0"
      y="0"
      maskUnits="userSpaceOnUse"
      style={{ maskType: "alpha" }}
    >
      <path
        fill="var(--color-brand-gemini-blue)"
        d="M141.201 4.886c2.282-6.17 11.042-6.071 13.184.148l5.985 17.37a184.004 184.004 0 0 0 111.257 113.049l19.304 6.997c6.143 2.227 6.156 10.91.02 13.155l-19.35 7.082a184.001 184.001 0 0 0-109.495 109.385l-7.573 20.629c-2.241 6.105-10.869 6.121-13.133.025l-7.908-21.296a184 184 0 0 0-109.02-108.658l-19.698-7.239c-6.102-2.243-6.118-10.867-.025-13.132l20.083-7.467A183.998 183.998 0 0 0 133.291 26.28l7.91-21.394Z"
      />
    </mask>
    <g mask="url(#gemini__a)">
      <g filter="url(#gemini__b)">
        <ellipse cx="163" cy="149" fill="var(--color-brand-gemini-blue-soft)" rx="196" ry="159" />
      </g>
      <g filter="url(#gemini__c)">
        <ellipse cx="33.5" cy="142.5" fill="var(--color-brand-gemini-yellow)" rx="68.5" ry="72.5" />
      </g>
      <g filter="url(#gemini__d)">
        <ellipse cx="19.5" cy="148.5" fill="var(--color-brand-gemini-yellow)" rx="68.5" ry="72.5" />
      </g>
      <g filter="url(#gemini__e)">
        <path
          fill="var(--color-brand-gemini-red)"
          d="M194 10.5C172 82.5 65.5 134.333 22.5 135L144-66l50 76.5Z"
        />
      </g>
      <g filter="url(#gemini__f)">
        <path
          fill="var(--color-brand-gemini-red)"
          d="M190.5-12.5C168.5 59.5 62 111.333 19 112L140.5-89l50 76.5Z"
        />
      </g>
      <g filter="url(#gemini__g)">
        <path
          fill="var(--color-brand-gemini-green)"
          d="M194.5 279.5C172.5 207.5 66 155.667 23 155l121.5 201 50-76.5Z"
        />
      </g>
      <g filter="url(#gemini__h)">
        <path
          fill="var(--color-brand-gemini-green)"
          d="M196.5 320.5C174.5 248.5 68 196.667 25 196l121.5 201 50-76.5Z"
        />
      </g>
    </g>
    <defs>
      <filter
        id="gemini__b"
        width="464"
        height="390"
        x="-69"
        y="-46"
        colorInterpolationFilters="sRGB"
        filterUnits="userSpaceOnUse"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur result="effect1_foregroundBlur_69_17998" stdDeviation="18" />
      </filter>
      <filter
        id="gemini__c"
        width="265"
        height="273"
        x="-99"
        y="6"
        colorInterpolationFilters="sRGB"
        filterUnits="userSpaceOnUse"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur result="effect1_foregroundBlur_69_17998" stdDeviation="32" />
      </filter>
      <filter
        id="gemini__d"
        width="265"
        height="273"
        x="-113"
        y="12"
        colorInterpolationFilters="sRGB"
        filterUnits="userSpaceOnUse"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur result="effect1_foregroundBlur_69_17998" stdDeviation="32" />
      </filter>
      <filter
        id="gemini__e"
        width="299.5"
        height="329"
        x="-41.5"
        y="-130"
        colorInterpolationFilters="sRGB"
        filterUnits="userSpaceOnUse"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur result="effect1_foregroundBlur_69_17998" stdDeviation="32" />
      </filter>
      <filter
        id="gemini__f"
        width="299.5"
        height="329"
        x="-45"
        y="-153"
        colorInterpolationFilters="sRGB"
        filterUnits="userSpaceOnUse"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur result="effect1_foregroundBlur_69_17998" stdDeviation="32" />
      </filter>
      <filter
        id="gemini__g"
        width="299.5"
        height="329"
        x="-41"
        y="91"
        colorInterpolationFilters="sRGB"
        filterUnits="userSpaceOnUse"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur result="effect1_foregroundBlur_69_17998" stdDeviation="32" />
      </filter>
      <filter
        id="gemini__h"
        width="299.5"
        height="329"
        x="-39"
        y="132"
        colorInterpolationFilters="sRGB"
        filterUnits="userSpaceOnUse"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur result="effect1_foregroundBlur_69_17998" stdDeviation="32" />
      </filter>
    </defs>
  </svg>
);

export const AntigravityIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 128 128" fill="none">
    <image href={ANTIGRAVITY_ICON_DATA_URL} width="128" height="128" />
  </svg>
);

export const GithubCopilotIcon: Icon = ({ className, ...props }) => (
  <svg
    {...props}
    preserveAspectRatio="xMidYMid"
    viewBox="0 0 256 208"
    className={cn("fill-black dark:fill-white", className)}
  >
    <path d="M205.3 31.4c14 14.8 20 35.2 22.5 63.6 6.6 0 12.8 1.5 17 7.2l7.8 10.6c2.2 3 3.4 6.6 3.4 10.4v28.7a12 12 0 0 1-4.8 9.5C215.9 187.2 172.3 208 128 208c-49 0-98.2-28.3-123.2-46.6a12 12 0 0 1-4.8-9.5v-28.7c0-3.8 1.2-7.4 3.4-10.5l7.8-10.5c4.2-5.7 10.4-7.2 17-7.2 2.5-28.4 8.4-48.8 22.5-63.6C77.3 3.2 112.6 0 127.6 0h.4c14.7 0 50.4 2.9 77.3 31.4ZM128 78.7c-3 0-6.5.2-10.3.6a27.1 27.1 0 0 1-6 12.1 45 45 0 0 1-32 13c-6.8 0-13.9-1.5-19.7-5.2-5.5 1.9-10.8 4.5-11.2 11-.5 12.2-.6 24.5-.6 36.8 0 6.1 0 12.3-.2 18.5 0 3.6 2.2 6.9 5.5 8.4C79.9 185.9 105 192 128 192s48-6 74.5-18.1a9.4 9.4 0 0 0 5.5-8.4c.3-18.4 0-37-.8-55.3-.4-6.6-5.7-9.1-11.2-11-5.8 3.7-13 5.1-19.7 5.1a45 45 0 0 1-32-12.9 27.1 27.1 0 0 1-6-12.1c-3.4-.4-6.9-.5-10.3-.6Zm-27 44c5.8 0 10.5 4.6 10.5 10.4v19.2a10.4 10.4 0 0 1-20.8 0V133c0-5.8 4.6-10.4 10.4-10.4Zm53.4 0c5.8 0 10.4 4.6 10.4 10.4v19.2a10.4 10.4 0 0 1-20.8 0V133c0-5.8 4.7-10.4 10.4-10.4Zm-73-94.4c-11.2 1.1-20.6 4.8-25.4 10-10.4 11.3-8.2 40.1-2.2 46.2A31.2 31.2 0 0 0 75 91.7c6.8 0 19.6-1.5 30.1-12.2 4.7-4.5 7.5-15.7 7.2-27-.3-9.1-2.9-16.7-6.7-19.9-4.2-3.6-13.6-5.2-24.2-4.3Zm69 4.3c-3.8 3.2-6.4 10.8-6.7 19.9-.3 11.3 2.5 22.5 7.2 27a41.7 41.7 0 0 0 30 12.2c8.9 0 17-2.9 21.3-7.2 6-6.1 8.2-34.9-2.2-46.3-4.8-5-14.2-8.8-25.4-9.9-10.6-1-20 .7-24.2 4.3ZM128 56c-2.6 0-5.6.2-9 .5.4 1.7.5 3.7.7 5.7 0 1.5 0 3-.2 4.5 3.2-.3 6-.3 8.5-.3 2.6 0 5.3 0 8.5.3-.2-1.6-.2-3-.2-4.5.2-2 .3-4 .7-5.7-3.4-.3-6.4-.5-9-.5Z" />
  </svg>
);

export const ACPRegistryIcon: Icon = ({ className, ...props }) => (
  <svg
    {...props}
    viewBox="0 0 576 220"
    fill="none"
    className={cn("fill-black dark:fill-white", className)}
  >
    <path d="M568.003 115.821L517.278 27.9661C507.183 10.4816 489.084 0.0227367 468.894 0.0227367C448.727 0.0227367 430.674 10.4361 420.556 27.8752L343.251 161.749H242.755C236.23 161.749 230.386 158.384 227.135 152.745C223.861 147.106 223.861 140.376 227.135 134.715L277.861 46.8603C281.112 41.2216 286.955 37.8338 293.481 37.8338C300.006 37.8338 305.827 41.1988 309.101 46.8603L312.125 52.0897C313.353 54.2042 315.604 55.5002 318.036 55.5002C320.469 55.5002 322.743 54.1815 323.948 52.067L337.385 28.5118C338.795 26.0335 338.522 22.9413 336.703 20.7586C325.699 7.57131 309.874 0 293.322 0C292.662 0 292.003 0 291.321 0.0454733C272.04 0.75031 254.76 11.1864 245.074 27.9434L200.215 105.657L155.81 29.1484C145.465 11.2092 126.594 0.0227367 106.608 0.0227367C105.949 0.0227367 105.289 0.0227367 104.607 0.06821C85.3265 0.773047 68.0467 11.2092 58.3608 27.9661L7.65806 115.821C-6.25678 139.899 -0.868187 168.82 21.05 187.759C29.8945 195.422 41.6039 199.628 54.0181 199.628H148.648C151.081 199.628 153.332 198.332 154.56 196.217L168.52 172.026C169.748 169.911 169.748 167.319 168.52 165.205C167.292 163.09 165.041 161.794 162.608 161.794H56.0417C49.5163 161.794 43.6729 158.429 40.4216 152.79C37.1475 147.152 37.1475 140.422 40.4216 134.76L91.1471 46.9057C94.3985 41.2671 100.242 37.8793 106.767 37.8793C113.293 37.8793 119.113 41.2443 122.387 46.9057L194.826 172.526C195.031 172.89 195.258 173.208 195.531 173.526C198.76 178.665 202.83 183.485 207.786 187.782C216.631 195.444 228.34 199.651 240.754 199.651H321.424L315.581 209.769C314.353 211.883 314.353 214.475 315.581 216.59C316.809 218.704 319.059 220 321.492 220H349.436C351.868 220 354.119 218.704 355.347 216.59L364.396 200.901L367.17 196.468C367.17 196.468 367.261 196.331 367.284 196.263L453.274 46.9285C456.525 41.2898 462.369 37.902 468.894 37.902C475.42 37.902 481.263 41.2671 484.514 46.9285L535.24 134.783C538.491 140.422 538.514 147.174 535.24 152.813C531.988 158.452 526.145 161.84 519.62 161.84H418.669C416.236 161.84 413.985 163.136 412.757 165.25L398.774 189.442C397.546 191.556 397.546 194.148 398.774 196.263C400.002 198.377 402.253 199.673 404.686 199.673H518.21C539.81 199.673 559.295 188.237 569.026 169.843C578.053 152.79 577.666 132.623 567.981 115.843L568.003 115.821Z" />
  </svg>
);

export const PiAgentIcon: Icon = ({ className, ...props }) => (
  <svg {...props} viewBox="0 0 800 800" fill="none" className={className}>
    <rect width="800" height="800" rx="160" fill="var(--color-black)" />
    <path
      fill="var(--color-white)"
      fillRule="evenodd"
      d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
    />
    <path fill="var(--color-white)" d="M517.36 400H634.72V634.72H517.36Z" />
  </svg>
);
