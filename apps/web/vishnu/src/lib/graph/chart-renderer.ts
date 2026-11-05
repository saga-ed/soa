import { init, use } from 'echarts/core';
import { LineChart, BarChart, ScatterChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
} from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
use([
  LineChart,
  BarChart,
  ScatterChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  SVGRenderer,
]);
export { init };
