import { ModelVar, OpExecutor, OpInputs, OpOutputs, AttrsData, InputFeed } from '../commons/interface';
import { GLOBALS } from '../globals';
import Tensor from './tensor';
import opBehaviors from './opBehaviors';

// model的名字和paddleJS的tensor名字mapping

export default class OpData {
    name: string = '';
    isPackedOp: boolean = false;
    input: OpInputs = {} as OpInputs;
    output: OpOutputs = {} as OpOutputs;
    data: AttrsData = {};
    attrs: object = {};
    subAttrs: object[] = [];
    inputTensors: Tensor[] = [];
    outputTensors: Tensor[] = [];
    fShaderParams: object[] = [];
    vars: ModelVar[] = [];
    iLayer: number = 0;
    program: string[] = [];
    renderData: object[] = [];
    inputFeed: InputFeed[] = [];
    tensorData: ModelVar[] = [];

    constructor(op: OpExecutor, iLayer: number, vars: ModelVar[], feed: InputFeed[]) {
        const {
            type,
            inputs,
            outputs,
            attrs,
            isPacked
        } = op;

        this.attrs = attrs;
        this.subAttrs = op.subAttrs;
        this.name = type;
        this.isPackedOp = isPacked;
        this.vars = vars;
        this.iLayer = iLayer;
        this.inputFeed = feed;
        this.input = inputs;
        this.output = outputs;
        // tensor数据
        this.inputTensors = [];
        this.outputTensors = [];
        this.fShaderParams = [];
        this.program = [];
        this.renderData = [];

        this.constructTensorData();
        this.buildTensor();
        this.buildShaderParams();
        this.buildProgram();

    }

    constructTensorData() {
        Object.keys(this.output).forEach(key => {
            this.output[key].forEach((name: string, index: number) => {
                this.output[key][index] = this.getTensorAttr(name)[0];
            });
        });

        Object.keys(this.input).forEach(key => {
            if (this.input[key][0] === 'image') {
                this.input[key] = this.inputFeed;
            }
            else {
                this.input[key] = this.getTensorAttr(this.input[key][0]);
            }
        });
        for (const key in this.output) {
            if (Object.prototype.hasOwnProperty.call(this.output, key)) {
                // 默认取第一个数据
                const data = this.output[key] || [{}];
                const tensorName = this.getExactTensorName(key);
                if (tensorName) {
                    data.forEach((item: ModelVar) => {
                        item.tensorName = tensorName;
                        this.tensorData.push(item);
                    });
                }
            }
        }
        for (const key in this.input) {
            if (Object.prototype.hasOwnProperty.call(this.input, key)) {
                const data = this.input[key] || [{}];
                // 默认取第一个数据
                const tensorName = this.getExactTensorName(key);
                if (tensorName) {
                    const tensor = data[0];
                    tensor.tensorName = tensorName;
                    this.tensorData.push(tensor);
                }
            }
        }
    }

    getExactTensorName(name) {
        // name map
        const tensorName = {
            input: 'origin',
            x: 'origin',
            filter: 'filter',
            y: 'counter',
            z: 'appender',
            output: 'out',
            out: 'out',
            scale: 'scale',
            bias: 'bias',
            mean: 'mean',
            variance: 'variance',
            w: 'weight'
        };
        return tensorName[name.toLowerCase()];
    }

    getTensorAttr(name: string) {
        return this.vars.filter(item => item.name === name);
    }

    buildProgram() {
        const name = this.name;
        this.program = this.outputTensors.map((outTensor, index) => GLOBALS.backendInstance.createProgram({
            name,
            outTensor,
            shaderParams: this.fShaderParams[index],
            runtime: index,
            isPacked: this.isPackedOp || false
        }));
    }

    buildRenderData() {
        const backendInstance = GLOBALS.backendInstance;
        if (backendInstance.createRenderData) { // webgpu 不需要
            this.renderData = backendInstance.createRenderData(this.inputTensors);
        }
    }

    // process op tensorData and attrs according to op behaviors
    processTensorDataAndAttrs() {
        const tensorData: ModelVar[] = this.tensorData;
        // unique behavior
        const opKey = `${GLOBALS.backend}_${this.name}`;
        const behaviorKeys = GLOBALS.opRegistry.ops[opKey]
            ? GLOBALS.opRegistry.ops[opKey].behaviors || []
            : [];
        behaviorKeys.forEach(key => {
            opBehaviors[key].call(this, tensorData);
        });
    }

    buildTensor() {
        this.processTensorDataAndAttrs();
        const tensorData: ModelVar[] = this.tensorData;
        // 生成tensor对象
        tensorData.forEach((data: ModelVar, index: number) => {
            const tensorName = data.tensorName as string;
            const tensor = new Tensor({
                type: data.name,
                name: tensorName,
                shape: data.shape,
                data: data.data || null,
                isPacked: this.isPackedOp || false,
                binding: index
            });
            if (tensorName === 'out') {
                this.outputTensors.push(tensor);
            }
            else {
                this.inputTensors.push(tensor);
            }
        });
    }

    buildShaderParams() {
        // 从tensor对象中获取的数据
        const tensorAttrs = [
            'length_shape',
            'width_shape',
            'height_shape',
            'width_texture',
            'height_texture',
            'limit',
            'channel',
            'total_shape',
            'binding'
        ];

        for (const key in this.attrs) {
            if (Object.prototype.hasOwnProperty.call(this.attrs, key)) {
                const item = this.attrs[key];
                this.data[key] = item;
            }
        }
        // 遍历 获取input tensor的数据
        this.inputTensors.forEach((inputTensor: Tensor) => {
            tensorAttrs.forEach(attr => {
                this.data[attr + '_' + inputTensor.name] = inputTensor[attr];
            });
        });

        // 根据out tensor 个数 生成对应的 fShader 个数
        this.outputTensors.forEach((outTensor: Tensor) => {
            const params = JSON.parse(JSON.stringify(this.data));
            // 获取output tensor的数据

            tensorAttrs.forEach(attr => {
                params[attr + '_' + outTensor.name] = outTensor[attr];
            });
            this.fShaderParams.push(params);
        });
    }
}