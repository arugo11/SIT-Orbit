declare module "encoding-japanese" {
  const Encoding: {
    stringToCode(value: string): number[];
    convert(value: number[], to: string, from: string): number[];
  };
  export default Encoding;
}
