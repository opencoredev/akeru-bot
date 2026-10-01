import { cn } from "~/lib/utils";
import { ANTIGRAVITY_ICON_DATA_URL } from "../Icons";
import { type Icon } from "./iconTypes";

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
        fill="#3186FF"
        d="M141.201 4.886c2.282-6.17 11.042-6.071 13.184.148l5.985 17.37a184.004 184.004 0 0 0 111.257 113.049l19.304 6.997c6.143 2.227 6.156 10.91.02 13.155l-19.35 7.082a184.001 184.001 0 0 0-109.495 109.385l-7.573 20.629c-2.241 6.105-10.869 6.121-13.133.025l-7.908-21.296a184 184 0 0 0-109.02-108.658l-19.698-7.239c-6.102-2.243-6.118-10.867-.025-13.132l20.083-7.467A183.998 183.998 0 0 0 133.291 26.28l7.91-21.394Z"
      />
    </mask>
    <g mask="url(#gemini__a)">
      <g filter="url(#gemini__b)">
        <ellipse cx="163" cy="149" fill="#3689FF" rx="196" ry="159" />
      </g>
      <g filter="url(#gemini__c)">
        <ellipse cx="33.5" cy="142.5" fill="#F6C013" rx="68.5" ry="72.5" />
      </g>
      <g filter="url(#gemini__d)">
        <ellipse cx="19.5" cy="148.5" fill="#F6C013" rx="68.5" ry="72.5" />
      </g>
      <g filter="url(#gemini__e)">
        <path fill="#FA4340" d="M194 10.5C172 82.5 65.5 134.333 22.5 135L144-66l50 76.5Z" />
      </g>
      <g filter="url(#gemini__f)">
        <path fill="#FA4340" d="M190.5-12.5C168.5 59.5 62 111.333 19 112L140.5-89l50 76.5Z" />
      </g>
      <g filter="url(#gemini__g)">
        <path fill="#14BB69" d="M194.5 279.5C172.5 207.5 66 155.667 23 155l121.5 201 50-76.5Z" />
      </g>
      <g filter="url(#gemini__h)">
        <path fill="#14BB69" d="M196.5 320.5C174.5 248.5 68 196.667 25 196l121.5 201 50-76.5Z" />
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
  <svg {...props} viewBox="0 0 800 800" className={cn("fill-none", className)}>
    <rect width="800" height="800" rx="160" fill="#000" />
    <path
      fill="#fff"
      fillRule="evenodd"
      d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
    />
    <path fill="#fff" d="M517.36 400H634.72V634.72H517.36Z" />
  </svg>
);
