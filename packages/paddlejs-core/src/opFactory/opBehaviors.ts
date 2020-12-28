import { OpData } from '../commons/interface';
import * as Utils from './utils';

interface Behaviors {
    [key: string]: (this: OpData, tensorData: any[]) => any;
}

const behaviors : Behaviors = {
    adaptPaddings() {
        for (const key in this.attrs) {
            if (Object.prototype.hasOwnProperty.call(this.attrs, key) && key === 'paddings') {
                const item = this.attrs[key];
                const [x, y] = item;
                if (x === 0 && y === 1) {
                    // 兼容paddings为[0, 1]的情况
                    this.attrs[key][1] = 0;
                }
                return;
            }
        }
    },

    inferShape() {
        const inputShape = this.input.X[0].shape;
        if (this.attrs.new_shape.toString() === this.output.Out[0].shape.toString()) {
            return;
        }
        const targetShape = this.attrs.new_shape;
        for (let i = 0; i < targetShape.length; i++) {
            if (targetShape[i] === 0) {
                targetShape[i] = inputShape[i];
            }
        }
        let total_length = inputShape.reduce((acc, cur) => acc * cur, 1);
        let minusPos = -1;
        for (let i = 0; i < targetShape.length; i++) {
            if (targetShape[i] === -1) {
                minusPos = i;
                continue;
            }
            total_length /= targetShape[i];
        }
        if (minusPos !== -1) {
            targetShape[minusPos] = total_length;
        }
        this.output.Out[0].shape = targetShape;
    },

    setPerm() {
        const arrayPerm : number[] = this.attrs['axis'];
        const length = arrayPerm.length;
        if (length > 4) {
            throw Error(`op transpoes2 axis length exceeds maximum length 4, get ${length}`);
        }
        const temp = new Array(length).fill(0);
        for (let i = 0; i < length; i++) {
            const index = arrayPerm[i];
            temp[index] = i;
        }
        for (let i = 0; i < 4; i++) {
            this.data[`perm_${i}`] = temp[i] || 0;
        }
        this.data['perm_size'] = length;
    },

    isGlobalPooling() {
        const counter = this.input.X[0] || {};
        const length = (counter.shape && counter.shape.length) || 0;
        if (length > 2 && this.attrs['global_pooling']) {
            this.attrs.ksize = [counter.shape[length - 2], counter.shape[length - 1]];
        }
    },

    mergeAttrs() {
        this.attrs = this.subAttrs.reduce((attrs, item) => {
            return Object.assign(attrs, item);
        }, {});
    },

    isApplySeparableConv(tensorData = []) {
        const groups = this.attrs.groups;
        let hasBias = false;
        let outC;
        const filter = tensorData.filter(item => {
            const { shape, tensorName } = item;
            if (tensorName === 'bias') {
                hasBias = true;
            }
            const [b, c, , ] = shape;
            if (!hasBias && !outC && tensorName === 'out') {
                outC = c;
            }

            return (b === groups) && (c === 1) && (item.tensorName === 'filter');
        });
        if (filter && filter.length) {
            // 可以执行separable conv
            this.name += '_depthwise';
        }

        !hasBias && tensorData.push({
            name: 'conv1_scale_offset',
            needBatch: true,
            persistable: true,
            shape: [outC],
            data: Array.from(new Float32Array(outC), () => 0),
            tensorName: 'bias'
        });
    },

    batchComputeConv2d() {
        const origin_shape_temp = this.input.Filter[0].shape;
        const inChannels = origin_shape_temp[1];
        this.attrs.filter_nearest_vec4 = Math.floor(inChannels / 4) * 4;
        this.attrs.filter_remainder_vec4 = inChannels % 4;
    },

    isMax() {
        const type = this.attrs['pooling_type'] === 'max' ? 1 : 0;
        this.attrs['pooling_type'] = type;
        if (type === 1) {
            this.name += '_max';
        }
    },

    transToPrelu() {
        this.data['multi_value'] = '0.0';
        this.data['active_function'] = 'prelu';
    },

    transToRelu6() {
        this.data['multi_value'] = this.attrs['threshold'];
        this.data['active_function'] = 'relu6';
    },

    transToLeakyrelu() {
        this.data['multi_value'] = this.attrs.alpha;
        this.data['active_function'] = 'leakyRelu';
        this.name = 'relu';
    },

    setActiveFunc() {
        // 用于融合op
        const mergeType = 'conv2d-elementwise_add';
        const suffix = this.name.replace(mergeType + '-', '');
        if (suffix === 'leaky_relu') {
            this.data['multi_value'] = this.attrs.alpha;
            this.data['active_function'] = 'leakyRelu';
        }
    },

    normalizeDim() {
        const origin_shape = this.input.X[0].shape;
        const axis = this.attrs.axis > -1 ? this.attrs.axis : origin_shape.length + this.attrs.axis;
        const dim_value: number[] = [];
        for (let index = 0; index < origin_shape[axis]; index++) {
            dim_value[index] = index;
        }
        this.attrs.target_length = dim_value.length;
        this.attrs.target_value = dim_value;
        // 保存 输入 tensor 对应dim 的长度
        this.attrs.inputs_dim = origin_shape[axis];
        this.attrs.dim = 4 - origin_shape.length + axis;
    },

    normalizeDim2() {
        const origin_shape = this.input.Y[0].shape;
        const axis = this.attrs.axis > -1 ? this.attrs.axis : origin_shape.length + this.attrs.axis;

        // 保存 输入 tensor 对应dim 的长度
        this.attrs.append_num = origin_shape[axis];
    },

    processAxis() {
        const shape_x = this.input.X[0].shape;
        const shape_y = this.input.Y[0].shape;
        const axis_temp = this.attrs['axis'];
        if (axis_temp === -1) {
            this.attrs['axis'] = shape_x.length - shape_y.length;
        }
        else {
            this.attrs['axis'] = 4 - shape_y.length - axis_temp;
        }
    },

    flattenShape(tensorData = []) {
        const target = tensorData.find(item => item.shape.length > 2);
        if (target) {
            const padShape = Utils.formatShape(target.shape);
            target.shape = [padShape[0] * padShape[2], padShape[1] * padShape[3]];
        }

    },

    reshape(tensorData = []) {
        let input = tensorData.find(item => item.tensorName === 'origin');
        let counter = tensorData.find(item => item.tensorName === 'counter');
        const out = tensorData.find(item => item.tensorName === 'out' || item.tensorName === 'output');

        if (counter.shape.length > input.shape.length) {
            const temp = counter;
            counter = input;
            input = temp;
        }

        if (input.shape.length > 2 && counter.shape.length === 2) {
            const shape = Utils.getReshapeInPaddle(input.shape, out.shape);
            input.shape = shape;
        }
    }
};


export default behaviors;